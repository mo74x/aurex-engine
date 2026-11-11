import {
  Injectable,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { VaultLedgerService } from './vault-ledger.service';
import { RedisService } from '../common/redis/redis.service';

@Injectable()
export class FractionalVaultService {
  private readonly BUYBACK_FEE_PCT = new Decimal('0.0015'); // 0.15% instant liquidity fee

  constructor(
    private readonly prisma: PrismaService,
    private readonly vaultLedger: VaultLedgerService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * 1. Lock physical 24K vault bars (e.g., 100g or 1000g kilobars) into the Fractional Backing Pool.
   * Credits LIABILITY:HOUSE_UNALLOCATED_POOL:XAU_G so customers can buy fractional grams against it.
   */
  async assignPhysicalBarToFractionalPool(
    serialNumber: string,
    adminUser: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const bar = await tx.physicalGoldIngot.findUnique({
        where: { serialNumber },
      });
      if (!bar || bar.status !== 'AVAILABLE' || bar.karat !== 24) {
        throw new BadRequestException(
          `Bar ${serialNumber} must be AVAILABLE and 24K to back the fractional vault.`,
        );
      }

      await tx.physicalGoldIngot.update({
        where: { id: bar.id },
        data: { status: 'MASTER_POOL_BACKING', version: { increment: 1 } },
      });

      const grams = new Decimal(bar.weightGrams.toString());

      await this.vaultLedger.postBalancedJournal(tx, {
        idempotencyKey: `POOL_LOAD:${serialNumber}`,
        referenceType: 'VAULT_POOL_BACKING',
        referenceId: serialNumber,
        description: `Physical 24K bar ${serialNumber} (${grams}g) locked into fractional backing pool by ${adminUser}`,
        legs: [
          {
            accountCode: `ASSET:PHYSICAL_VAULT_POOL:${bar.countryCode}:XAU_G`,
            accountName: `${bar.countryCode} Physical 24K Master Bar Pool`,
            accountType: 'ASSET',
            currency: 'XAU_G',
            direction: 'DEBIT',
            amount: grams,
          },
          {
            accountCode: `LIABILITY:HOUSE_UNALLOCATED_POOL:${bar.countryCode}:XAU_G`,
            accountName: `${bar.countryCode} Available Fractional Gold Pool`,
            accountType: 'LIABILITY',
            currency: 'XAU_G',
            direction: 'CREDIT',
            amount: grams,
          },
        ],
      });

      return {
        serialNumber,
        addedGrams24k: grams.toNumber(),
        status: 'MASTER_POOL_BACKING',
      };
    });
  }

  /**
   * 2. Buy Fractional 24K Gold (Debits User Fiat Escrow/Wallet -> Credits User XAU_G Vault)
   */
  async buyFractionalGold(params: {
    userId: string;
    countryCode: 'EG' | 'SA' | 'AE' | 'OM';
    gramsToBuy?: number;
    fiatAmountToSpend?: number;
    maxAcceptableAskPerGram?: number;
    idempotencyKey: string;
  }) {
    const liveMatrix = await this.getLiveCountryMatrix(params.countryCode);
    const decimals = params.countryCode === 'OM' ? 3 : 2;
    const ask24k = new Decimal(liveMatrix.karats['24K'].ask);

    if (
      params.maxAcceptableAskPerGram &&
      ask24k.gt(new Decimal(params.maxAcceptableAskPerGram))
    ) {
      throw new ConflictException(
        `Slippage guard triggered: Live 24K Ask (${ask24k}) exceeds max acceptable (${params.maxAcceptableAskPerGram})`,
      );
    }

    // Calculate exact grams (4 decimals) and fiat cost
    let grams: Decimal;
    let fiatCost: Decimal;

    if (params.gramsToBuy && params.gramsToBuy > 0) {
      grams = new Decimal(params.gramsToBuy).toDecimalPlaces(
        4,
        Decimal.ROUND_DOWN,
      );
      fiatCost = grams
        .mul(ask24k)
        .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    } else if (params.fiatAmountToSpend && params.fiatAmountToSpend > 0) {
      fiatCost = new Decimal(params.fiatAmountToSpend).toDecimalPlaces(
        decimals,
      );
      grams = fiatCost.div(ask24k).toDecimalPlaces(4, Decimal.ROUND_DOWN);
    } else {
      throw new BadRequestException(
        'Provide either gramsToBuy or fiatAmountToSpend',
      );
    }

    if (grams.lt('0.0100')) {
      throw new BadRequestException(
        'Minimum fractional purchase is 0.0100 grams of 24K gold.',
      );
    }

    const currency = liveMatrix.currency;

    return this.prisma.$transaction(async (tx) => {
      // A. Fiat Book Journal: Debit User Fiat Escrow -> Credit Fractional Sales Revenue
      await this.vaultLedger.postBalancedJournal(tx, {
        idempotencyKey: `FRAC_BUY_FIAT:${params.idempotencyKey}`,
        referenceType: 'FRACTIONAL_GOLD_BUY',
        referenceId: params.userId,
        description: `Buy ${grams.toFixed(4)}g 24K @ ${ask24k} ${currency}/g`,
        legs: [
          {
            accountCode: `LIABILITY:USER_ESCROW:${params.userId}:${currency}`,
            accountName: `User ${params.userId} ${currency} Wallet`,
            accountType: 'LIABILITY',
            currency,
            direction: 'DEBIT',
            amount: fiatCost,
          },
          {
            accountCode: `REVENUE:FRACTIONAL_GOLD_SALES:${currency}`,
            accountName: `${currency} Fractional Gold Sales`,
            accountType: 'REVENUE',
            currency,
            direction: 'CREDIT',
            amount: fiatCost,
          },
        ],
      });

      // B. Gold Book Journal (XAU_G): Debit House Unallocated Pool -> Credit User Gold Vault
      const housePoolCode = `LIABILITY:HOUSE_UNALLOCATED_POOL:${params.countryCode}:XAU_G`;
      const userVaultCode = `LIABILITY:USER_GOLD_VAULT:${params.userId}:XAU_G`;

      await this.vaultLedger.postBalancedJournal(tx, {
        idempotencyKey: `FRAC_BUY_XAU:${params.idempotencyKey}`,
        referenceType: 'FRACTIONAL_GOLD_BUY',
        referenceId: params.userId,
        description: `Allocate ${grams.toFixed(4)}g 24K from Master Backing Pool to ${params.userId}`,
        legs: [
          {
            accountCode: housePoolCode,
            accountName: `${params.countryCode} Available Fractional Gold Pool`,
            accountType: 'LIABILITY',
            currency: 'XAU_G',
            direction: 'DEBIT',
            amount: grams,
          },
          {
            accountCode: userVaultCode,
            accountName: `User ${params.userId} 24K Vault`,
            accountType: 'LIABILITY',
            currency: 'XAU_G',
            direction: 'CREDIT',
            amount: grams,
          },
        ],
      });

      // C. Update Weighted Average Cost (WAC) Position
      const existingPos = await tx.goldVaultPosition.findUnique({
        where: {
          userId_countryCode: {
            userId: params.userId,
            countryCode: params.countryCode,
          },
        },
      });

      const oldGrams = existingPos
        ? new Decimal(existingPos.totalGrams24k.toString())
        : new Decimal(0);
      const oldWac = existingPos
        ? new Decimal(existingPos.weightedAvgCostPerG.toString())
        : new Decimal(0);
      const newTotalGrams = oldGrams.plus(grams);
      const newWac = oldGrams
        .mul(oldWac)
        .plus(grams.mul(ask24k))
        .div(newTotalGrams)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

      const position = await tx.goldVaultPosition.upsert({
        where: {
          userId_countryCode: {
            userId: params.userId,
            countryCode: params.countryCode,
          },
        },
        update: {
          totalGrams24k: newTotalGrams.toFixed(4),
          weightedAvgCostPerG: newWac.toFixed(4),
        },
        create: {
          userId: params.userId,
          countryCode: params.countryCode,
          currency,
          totalGrams24k: newTotalGrams.toFixed(4),
          weightedAvgCostPerG: newWac.toFixed(4),
        },
      });

      return {
        action: 'BUY_FRACTIONAL_24K',
        gramsPurchased: grams.toNumber(),
        executionAskPerGram: ask24k.toNumber(),
        totalFiatDebited: fiatCost.toNumber(),
        currency,
        newVaultBalanceGrams: Number(position.totalGrams24k),
        weightedAvgCostPerGram: Number(position.weightedAvgCostPerG),
      };
    });
  }

  /**
   * 3. Instant Dealer Buyback (Sell Fractional 24K Gold back to Aurex at Live Bid Price)
   */
  async sellGoldInstantBuyback(params: {
    userId: string;
    countryCode: 'EG' | 'SA' | 'AE' | 'OM';
    gramsToSell: number;
    minAcceptableBidPerGram?: number;
    idempotencyKey: string;
  }) {
    const grams = new Decimal(params.gramsToSell).toDecimalPlaces(
      4,
      Decimal.ROUND_DOWN,
    );
    if (grams.lte(0)) {
      throw new BadRequestException('gramsToSell must be greater than 0');
    }

    const liveMatrix = await this.getLiveCountryMatrix(params.countryCode);
    const decimals = params.countryCode === 'OM' ? 3 : 2;
    const bid24k = new Decimal(liveMatrix.karats['24K'].bid);
    const currency = liveMatrix.currency;

    // 1. Slippage Guard: Protect user if spot gold dipped while clicking "Sell Now"
    if (
      params.minAcceptableBidPerGram &&
      bid24k.lt(new Decimal(params.minAcceptableBidPerGram))
    ) {
      throw new ConflictException(
        `Live 24K Bid price (${bid24k} ${currency}/g) dropped below your minimum limit (${params.minAcceptableBidPerGram} ${currency}/g).`,
      );
    }

    const grossProceeds = grams
      .mul(bid24k)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const liquidationFee = grossProceeds
      .mul(this.BUYBACK_FEE_PCT)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const netFiatPayout = grossProceeds.minus(liquidationFee);

    return this.prisma.$transaction(async (tx) => {
      const userVaultCode = `LIABILITY:USER_GOLD_VAULT:${params.userId}:XAU_G`;
      const housePoolCode = `LIABILITY:HOUSE_UNALLOCATED_POOL:${params.countryCode}:XAU_G`;

      // A. Gold Book Journal (XAU_G): Debit User Gold Vault -> Credit House Unallocated Pool
      // Note: VaultLedgerService will throw ConflictException if user balance drops below 0!
      await this.vaultLedger.postBalancedJournal(tx, {
        idempotencyKey: `BUYBACK_XAU:${params.idempotencyKey}`,
        referenceType: 'INSTANT_DEALER_BUYBACK',
        referenceId: params.userId,
        description: `Instant buyback of ${grams.toFixed(4)}g 24K returned to Master Pool`,
        legs: [
          {
            accountCode: userVaultCode,
            accountName: `User ${params.userId} 24K Vault`,
            accountType: 'LIABILITY',
            currency: 'XAU_G',
            direction: 'DEBIT',
            amount: grams,
          },
          {
            accountCode: housePoolCode,
            accountName: `${params.countryCode} Available Fractional Gold Pool`,
            accountType: 'LIABILITY',
            currency: 'XAU_G',
            direction: 'CREDIT',
            amount: grams,
          },
        ],
      });

      // B. Fiat Book Journal: Debit Treasury Gold Desk -> Credit User Fiat Wallet + Buyback Fee
      await this.vaultLedger.postBalancedJournal(tx, {
        idempotencyKey: `BUYBACK_FIAT:${params.idempotencyKey}`,
        referenceType: 'INSTANT_DEALER_BUYBACK',
        referenceId: params.userId,
        description: `Instant buyback payout for ${grams.toFixed(4)}g 24K @ ${bid24k} ${currency}/g`,
        legs: [
          {
            accountCode: `ASSET:TREASURY_GOLD_DESK:${currency}`,
            accountName: `${currency} Treasury Buyback Desk`,
            accountType: 'ASSET',
            currency,
            direction: 'DEBIT',
            amount: grossProceeds,
          },
          {
            accountCode: `LIABILITY:USER_ESCROW:${params.userId}:${currency}`,
            accountName: `User ${params.userId} ${currency} Wallet`,
            accountType: 'LIABILITY',
            currency,
            direction: 'CREDIT',
            amount: netFiatPayout,
          },
          {
            accountCode: `REVENUE:BUYBACK_LIQUIDATION_FEE:${currency}`,
            accountName: `${currency} Instant Buyback Fee Revenue`,
            accountType: 'REVENUE',
            currency,
            direction: 'CREDIT',
            amount: liquidationFee,
          },
        ],
      });

      // C. Update User Vault Position & Realized P&L
      const pos = await tx.goldVaultPosition.findUniqueOrThrow({
        where: {
          userId_countryCode: {
            userId: params.userId,
            countryCode: params.countryCode,
          },
        },
      });

      const oldGrams = new Decimal(pos.totalGrams24k.toString());
      const wac = new Decimal(pos.weightedAvgCostPerG.toString());
      const remainingGrams = oldGrams.minus(grams);

      const costBasisOfSoldGrams = grams.mul(wac);
      const tradePnl = netFiatPayout
        .minus(costBasisOfSoldGrams)
        .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
      const cumulativeRealizedPnl = new Decimal(
        pos.realizedPnl.toString(),
      ).plus(tradePnl);

      const updatedPos = await tx.goldVaultPosition.update({
        where: { id: pos.id },
        data: {
          totalGrams24k: remainingGrams.toFixed(4),
          weightedAvgCostPerG: remainingGrams.eq(0) ? '0.0000' : wac.toFixed(4),
          realizedPnl: cumulativeRealizedPnl.toFixed(4),
        },
      });

      return {
        action: 'INSTANT_DEALER_BUYBACK',
        gramsSold: grams.toNumber(),
        executionBidPerGram: bid24k.toNumber(),
        grossProceeds: grossProceeds.toNumber(),
        liquidationFee: liquidationFee.toNumber(),
        netFiatCreditedToWallet: netFiatPayout.toNumber(),
        realizedPnlOnTrade: tradePnl.toNumber(),
        remainingVaultGrams: Number(updatedPos.totalGrams24k),
        currency,
        settledAt: new Date().toISOString(),
      };
    });
  }

  /**
   * 4. Live Portfolio Valuation (Combines SQL Cost-Basis with Sub-Second Redis Bid Tick)
   */
  async getLiveUserVaultPortfolio(
    userId: string,
    countryCode: 'EG' | 'SA' | 'AE' | 'OM',
  ) {
    const [pos, liveMatrix, fiatAcc] = await Promise.all([
      this.prisma.goldVaultPosition.findUnique({
        where: { userId_countryCode: { userId, countryCode } },
      }),
      this.getLiveCountryMatrix(countryCode),
      this.prisma.ledgerAccount.findUnique({
        where: {
          code: `LIABILITY:USER_ESCROW:${userId}:${liveMatrixCurrency(countryCode)}`,
        },
      }),
    ]);

    const decimals = countryCode === 'OM' ? 3 : 2;
    const liveBid24k = new Decimal(liveMatrix.karats['24K'].bid);
    const grams = pos
      ? new Decimal(pos.totalGrams24k.toString())
      : new Decimal(0);
    const wac = pos
      ? new Decimal(pos.weightedAvgCostPerG.toString())
      : new Decimal(0);

    const currentLiquidationValue = grams
      .mul(liveBid24k)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const totalCostBasis = grams
      .mul(wac)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
    const unrealizedPnl = currentLiquidationValue.minus(totalCostBasis);

    return {
      userId,
      countryCode,
      currency: liveMatrix.currency,
      vaultGrams24k: grams.toNumber(),
      weightedAvgCostPerGram: wac.toNumber(),
      liveBidPerGram: liveBid24k.toNumber(),
      instantLiquidationValue: currentLiquidationValue.toNumber(),
      unrealizedPnl: unrealizedPnl.toNumber(),
      realizedPnl: pos ? Number(pos.realizedPnl) : 0,
      fiatWalletBalance: fiatAcc ? Number(fiatAcc.balance) : 0,
      eligibleForPhysical10gRedemption: grams.gte(10),
    };
  }

  private async getLiveCountryMatrix(countryCode: string) {
    const raw = await this.redisService
      .getClient()
      .get(`aurex:price:${countryCode}`);
    if (!raw) {
      throw new ServiceUnavailableException(
        `Live gold feed for ${countryCode} is stale or offline. Fractional trading paused.`,
      );
    }
    return JSON.parse(raw);
  }
}

function liveMatrixCurrency(code: 'EG' | 'SA' | 'AE' | 'OM') {
  return { EG: 'EGP', SA: 'SAR', AE: 'AED', OM: 'OMR' }[code];
}
