import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, AccountType, EntryDirection } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../database/prisma.service';

export interface JournalLegInput {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  currency: string;
  direction: EntryDirection;
  amount: Decimal | number | string;
}

@Injectable()
export class VaultLedgerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Executes an atomic double-entry journal posting inside an existing or new Prisma transaction.
   * Guarantees debits == credits, deterministic account locking to prevent deadlocks,
   * and strict overdraft prevention across all customer liability and pool accounts.
   */
  async postBalancedJournal(
    tx: Prisma.TransactionClient,
    params: {
      idempotencyKey: string;
      referenceType: string;
      referenceId: string;
      description: string;
      legs: JournalLegInput[];
    },
  ) {
    // 1. Verify Double-Entry Balance (Total Debits == Total Credits)
    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);

    for (const leg of params.legs) {
      const amt = new Decimal(leg.amount);
      if (amt.lte(0)) {
        throw new BadRequestException(
          `Journal leg amount must be > 0 (${leg.accountCode})`,
        );
      }
      if (leg.direction === 'DEBIT') totalDebits = totalDebits.plus(amt);
      else totalCredits = totalCredits.plus(amt);
    }

    if (!totalDebits.equals(totalCredits)) {
      throw new UnprocessableEntityException(
        `Unbalanced journal rejected! Debits (${totalDebits}) != Credits (${totalCredits})`,
      );
    }

    // 2. Ensure all accounts exist, then sort alphabetically by code to prevent deadlocks
    const sortedLegs = [...params.legs].sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode),
    );

    for (const leg of sortedLegs) {
      await tx.ledgerAccount.upsert({
        where: { code: leg.accountCode },
        update: {},
        create: {
          code: leg.accountCode,
          name: leg.accountName,
          type: leg.accountType,
          currency: leg.currency,
          balance: 0,
        },
      });
    }

    // 3. Create parent JournalTransaction (throws unique constraint on duplicate idempotencyKey)
    const journalTx = await tx.journalTransaction.create({
      data: {
        idempotencyKey: params.idempotencyKey,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        description: params.description,
      },
    });

    // 4. Lock accounts in deterministic order and apply balance math
    for (const leg of sortedLegs) {
      const lockedRows = await tx.$queryRaw<
        Array<{ id: string; balance: Prisma.Decimal; type: AccountType }>
      >`
        SELECT id, balance, type
        FROM "LedgerAccount"
        WHERE code = ${leg.accountCode}
        FOR UPDATE
      `;

      const account = lockedRows[0];
      const currentBal = new Decimal(account.balance.toString());
      const amount = new Decimal(leg.amount);

      // Normal balance rules:
      // ASSET & EXPENSE increase on DEBIT, decrease on CREDIT
      // LIABILITY & REVENUE increase on CREDIT, decrease on DEBIT
      const isDebitNormal =
        account.type === 'ASSET' || account.type === 'EXPENSE';
      const delta =
        (isDebitNormal && leg.direction === 'DEBIT') ||
        (!isDebitNormal && leg.direction === 'CREDIT')
          ? amount
          : amount.negated();

      const nextBalance = currentBal.plus(delta);

      // Prevent customer balances & vault backing pools from ever going negative
      if (
        (leg.accountCode.startsWith('LIABILITY:USER_ESCROW:') ||
          leg.accountCode.startsWith('LIABILITY:USER_GOLD_VAULT:') ||
          leg.accountCode.startsWith('LIABILITY:HOUSE_UNALLOCATED_POOL:')) &&
        nextBalance.lt(0)
      ) {
        throw new ConflictException(
          `Insufficient balance in ${leg.accountCode}. Available: ${currentBal.toFixed(4)}, Required: ${amount.toFixed(4)}`,
        );
      }

      await tx.ledgerAccount.update({
        where: { id: account.id },
        data: {
          balance: nextBalance.toFixed(4),
          version: { increment: 1 },
        },
      });

      await tx.ledgerEntry.create({
        data: {
          transactionId: journalTx.id,
          accountId: account.id,
          direction: leg.direction,
          amount: amount.toFixed(4),
          runningAfter: nextBalance.toFixed(4),
        },
      });
    }

    return journalTx;
  }

  /**
   * Reserves physical serialized gold bars using PostgreSQL FOR UPDATE SKIP LOCKED
   * so concurrent checkouts never collide or wait on the same physical bar.
   */
  async allocatePhysicalIngots(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      userId: string;
      countryCode: string;
      items: Array<{ sku: string; quantity: number }>;
    },
  ) {
    const allocatedIngots: Array<{
      id: string;
      serialNumber: string;
      sku: string;
      vaultLocation: string;
      assayCertHash: string;
    }> = [];

    for (const item of params.items) {
      const availableRows = await tx.$queryRaw<
        Array<{
          id: string;
          serialNumber: string;
          sku: string;
          vaultLocation: string;
          assayCertHash: string;
        }>
      >`
        SELECT id, "serialNumber", sku, "vaultLocation", "assayCertHash"
        FROM "PhysicalGoldIngot"
        WHERE sku = ${item.sku}
          AND "countryCode" = ${params.countryCode}
          AND status = 'AVAILABLE'
        ORDER BY "serialNumber" ASC
        LIMIT ${item.quantity}
        FOR UPDATE SKIP LOCKED
      `;

      if (availableRows.length < item.quantity) {
        throw new ConflictException(
          `Vault stock exhausted for SKU ${item.sku}. Requested: ${item.quantity}, Available in vault: ${availableRows.length}`,
        );
      }

      const ids = availableRows.map((r) => r.id);
      await tx.physicalGoldIngot.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'ALLOCATED',
          allocatedOrderId: params.orderId,
          allocatedUserId: params.userId,
          allocatedAt: new Date(),
          version: { increment: 1 },
        },
      });

      allocatedIngots.push(...availableRows);
    }

    return allocatedIngots;
  }

  /**
   * Workflow 1: Settle an on-time or slippage-absorbed order via payment gateway / inbound transfer,
   * post double-entry revenue/escrow legs, and allocate physical bar serials.
   */
  async recordConfirmedOrderWithSerials(params: {
    quoteId: string;
    userId: string;
    countryCode: string;
    currency: string;
    providerTxId: string;
    lockedGrandTotal: number;
    liveRecalculatedTotal: number;
    paidAmount: number;
    absorbedCostByDealer: number;
    items: Array<{ sku: string; quantity: number }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const userEscrowCode = `LIABILITY:USER_ESCROW:${params.userId}:${params.currency}`;
      const gatewayCode = `ASSET:GATEWAY_CLEARING:${params.currency}`;
      const salesRevenueCode = `REVENUE:GOLD_SALES:${params.currency}`;

      // 1. Credit Customer Escrow from Gateway Clearing
      await this.postBalancedJournal(tx, {
        idempotencyKey: `DEPOSIT:${params.providerTxId}`,
        referenceType: 'ESCROW_DEPOSIT',
        referenceId: params.quoteId,
        description: `Inbound payment ${params.providerTxId} credited to user escrow`,
        legs: [
          {
            accountCode: gatewayCode,
            accountName: `${params.currency} Gateway Clearing`,
            accountType: 'ASSET',
            currency: params.currency,
            direction: 'DEBIT',
            amount: params.paidAmount,
          },
          {
            accountCode: userEscrowCode,
            accountName: `User ${params.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: params.currency,
            direction: 'CREDIT',
            amount: params.paidAmount,
          },
        ],
      });

      // 2. Sweep Customer Escrow into Gold Sales Revenue (plus Dealer Slippage Expense if any)
      const settlementLegs: JournalLegInput[] = [
        {
          accountCode: userEscrowCode,
          accountName: `User ${params.userId} Escrow`,
          accountType: 'LIABILITY',
          currency: params.currency,
          direction: 'DEBIT',
          amount: params.paidAmount,
        },
      ];

      if (params.absorbedCostByDealer > 0) {
        settlementLegs.push({
          accountCode: `EXPENSE:SLIPPAGE_ABSORBED:${params.currency}`,
          accountName: 'Dealer Absorbed Late-Payment Slippage',
          accountType: 'EXPENSE',
          currency: params.currency,
          direction: 'DEBIT',
          amount: params.absorbedCostByDealer,
        });
      }

      const totalRecognizedRevenue = new Decimal(params.paidAmount).plus(
        params.absorbedCostByDealer,
      );

      settlementLegs.push({
        accountCode: salesRevenueCode,
        accountName: `${params.currency} Gold Bullion Sales Revenue`,
        accountType: 'REVENUE',
        currency: params.currency,
        direction: 'CREDIT',
        amount: totalRecognizedRevenue,
      });

      await this.postBalancedJournal(tx, {
        idempotencyKey: `SETTLE:${params.quoteId}`,
        referenceType: 'ORDER_SETTLEMENT',
        referenceId: params.quoteId,
        description: `Order settlement and physical bar allocation for ${params.quoteId}`,
        legs: settlementLegs,
      });

      // 3. Create GoldOrder record
      const order = await tx.goldOrder.create({
        data: {
          quoteId: params.quoteId,
          userId: params.userId,
          countryCode: params.countryCode,
          currency: params.currency,
          status: 'ALLOCATED_READY_TO_SHIP',
          lockedGrandTotal: params.lockedGrandTotal,
          finalSettledTotal: totalRecognizedRevenue.toNumber(),
          paidAmount: params.paidAmount,
          absorbedSlippageCost: params.absorbedCostByDealer,
          requiredTopUpAmount: 0,
        },
      });

      // 4. Reserve physical serialized bars in the vault via FOR UPDATE SKIP LOCKED
      const serials = await this.allocatePhysicalIngots(tx, {
        orderId: order.id,
        userId: params.userId,
        countryCode: params.countryCode,
        items: params.items,
      });

      return { order, allocatedIngots: serials };
    });
  }

  /**
   * Workflow 2: Settle directly from pre-funded user wallet/escrow balance
   */
  async settleDirectFromEscrow(params: {
    quoteId: string;
    userId: string;
    countryCode: string;
    currency: string;
    grandTotal: number;
    paymentReference: string;
    items: Array<{ sku: string; quantity: number }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const userEscrowCode = `LIABILITY:USER_ESCROW:${params.userId}:${params.currency}`;
      const salesRevenueCode = `REVENUE:GOLD_SALES:${params.currency}`;

      // 1. Debit User Escrow -> Credit Gold Sales Revenue
      await this.postBalancedJournal(tx, {
        idempotencyKey: `DIRECT_SETTLE:${params.quoteId}`,
        referenceType: 'ORDER_SETTLEMENT',
        referenceId: params.quoteId,
        description: `Direct wallet payment for quote ${params.quoteId} (ref: ${params.paymentReference})`,
        legs: [
          {
            accountCode: userEscrowCode,
            accountName: `User ${params.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: params.currency,
            direction: 'DEBIT',
            amount: params.grandTotal,
          },
          {
            accountCode: salesRevenueCode,
            accountName: `${params.currency} Gold Bullion Sales Revenue`,
            accountType: 'REVENUE',
            currency: params.currency,
            direction: 'CREDIT',
            amount: params.grandTotal,
          },
        ],
      });

      // 2. Create GoldOrder record
      const order = await tx.goldOrder.create({
        data: {
          quoteId: params.quoteId,
          userId: params.userId,
          countryCode: params.countryCode,
          currency: params.currency,
          status: 'ALLOCATED_READY_TO_SHIP',
          lockedGrandTotal: params.grandTotal,
          finalSettledTotal: params.grandTotal,
          paidAmount: params.grandTotal,
          absorbedSlippageCost: 0,
          requiredTopUpAmount: 0,
        },
      });

      // 3. Allocate Physical Serials
      const allocatedIngots = await this.allocatePhysicalIngots(tx, {
        orderId: order.id,
        userId: params.userId,
        countryCode: params.countryCode,
        items: params.items,
      });

      return { order, allocatedIngots };
    });
  }

  /**
   * Workflow 3: Hold a late payment in Customer Escrow when slippage > 0.35%
   */
  async holdLatePaymentInEscrow(params: {
    quoteId: string;
    userId: string;
    countryCode: string;
    currency: string;
    providerTxId: string;
    lockedGrandTotal: number;
    liveRecalculatedTotal: number;
    paidAmount: number;
    requiredTopUpAmount: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const userEscrowCode = `LIABILITY:USER_ESCROW:${params.userId}:${params.currency}`;
      const gatewayCode = `ASSET:GATEWAY_CLEARING:${params.currency}`;

      await this.postBalancedJournal(tx, {
        idempotencyKey: `ESCROW_HOLD:${params.providerTxId}`,
        referenceType: 'ESCROW_DEPOSIT',
        referenceId: params.quoteId,
        description: `Late payment held in customer escrow pending top-up or refund`,
        legs: [
          {
            accountCode: gatewayCode,
            accountName: `${params.currency} Gateway Clearing`,
            accountType: 'ASSET',
            currency: params.currency,
            direction: 'DEBIT',
            amount: params.paidAmount,
          },
          {
            accountCode: userEscrowCode,
            accountName: `User ${params.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: params.currency,
            direction: 'CREDIT',
            amount: params.paidAmount,
          },
        ],
      });

      return tx.goldOrder.create({
        data: {
          quoteId: params.quoteId,
          userId: params.userId,
          countryCode: params.countryCode,
          currency: params.currency,
          status: 'ESCROW_HOLD',
          lockedGrandTotal: params.lockedGrandTotal,
          finalSettledTotal: params.liveRecalculatedTotal,
          paidAmount: params.paidAmount,
          requiredTopUpAmount: params.requiredTopUpAmount,
        },
      });
    });
  }

  /**
   * Workflow 4: Customer pays Top-Up difference -> Sweep combined escrow & allocate serials
   */
  async topUpEscrowAndAllocate(params: {
    quoteId: string;
    userId: string;
    topUpTxId: string;
    topUpPaidAmount: number;
    items: Array<{ sku: string; quantity: number }>;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.goldOrder.findUnique({
        where: { quoteId: params.quoteId },
      });
      if (!order || order.status !== 'ESCROW_HOLD') {
        throw new BadRequestException(
          `Order for quote ${params.quoteId} is not in ESCROW_HOLD`,
        );
      }

      const requiredTopUp = new Decimal(order.requiredTopUpAmount.toString());
      const paidTopUp = new Decimal(params.topUpPaidAmount);
      if (paidTopUp.lt(requiredTopUp)) {
        throw new BadRequestException(
          `Top-up amount (${paidTopUp}) is less than required (${requiredTopUp})`,
        );
      }

      const userEscrowCode = `LIABILITY:USER_ESCROW:${order.userId}:${order.currency}`;
      const gatewayCode = `ASSET:GATEWAY_CLEARING:${order.currency}`;
      const salesRevenueCode = `REVENUE:GOLD_SALES:${order.currency}`;

      // 1. Credit Top-Up into User Escrow
      await this.postBalancedJournal(tx, {
        idempotencyKey: `TOPUP_DEPOSIT:${params.topUpTxId}`,
        referenceType: 'ESCROW_TOPUP',
        referenceId: params.quoteId,
        description: `Escrow top-up payment ${params.topUpTxId}`,
        legs: [
          {
            accountCode: gatewayCode,
            accountName: `${order.currency} Gateway Clearing`,
            accountType: 'ASSET',
            currency: order.currency,
            direction: 'DEBIT',
            amount: paidTopUp,
          },
          {
            accountCode: userEscrowCode,
            accountName: `User ${order.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: order.currency,
            direction: 'CREDIT',
            amount: paidTopUp,
          },
        ],
      });

      const totalEscrowToSweep = new Decimal(order.paidAmount.toString()).plus(
        paidTopUp,
      );

      // 2. Sweep full combined Escrow into Gold Sales Revenue
      await this.postBalancedJournal(tx, {
        idempotencyKey: `TOPUP_SETTLE:${params.quoteId}`,
        referenceType: 'ORDER_SETTLEMENT',
        referenceId: params.quoteId,
        description: `Full settlement after escrow top-up for ${params.quoteId}`,
        legs: [
          {
            accountCode: userEscrowCode,
            accountName: `User ${order.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: order.currency,
            direction: 'DEBIT',
            amount: totalEscrowToSweep,
          },
          {
            accountCode: salesRevenueCode,
            accountName: `${order.currency} Gold Bullion Sales Revenue`,
            accountType: 'REVENUE',
            currency: order.currency,
            direction: 'CREDIT',
            amount: totalEscrowToSweep,
          },
        ],
      });

      // 3. Allocate Physical Vault Serials
      const allocatedIngots = await this.allocatePhysicalIngots(tx, {
        orderId: order.id,
        userId: order.userId,
        countryCode: order.countryCode,
        items: params.items,
      });

      const updatedOrder = await tx.goldOrder.update({
        where: { id: order.id },
        data: {
          status: 'ALLOCATED_READY_TO_SHIP',
          paidAmount: totalEscrowToSweep.toFixed(4),
          requiredTopUpAmount: 0,
        },
      });

      return { order: updatedOrder, allocatedIngots };
    });
  }

  /**
   * Workflow 5: Instant 1-Click Escrow Refund if customer declines the spiked price
   */
  async refundEscrowOrder(quoteId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      const order = await tx.goldOrder.findUnique({ where: { quoteId } });
      if (!order || order.status !== 'ESCROW_HOLD' || order.userId !== userId) {
        throw new BadRequestException(`Cannot refund quote ${quoteId}`);
      }

      const refundAmount = new Decimal(order.paidAmount.toString());
      const userEscrowCode = `LIABILITY:USER_ESCROW:${order.userId}:${order.currency}`;
      const payoutClearingCode = `ASSET:PAYOUT_CLEARING:${order.currency}`;

      // Debit User Escrow (zeros out liability) & Credit Payout Clearing
      const refundJournal = await this.postBalancedJournal(tx, {
        idempotencyKey: `REFUND:${quoteId}`,
        referenceType: 'ESCROW_REFUND',
        referenceId: quoteId,
        description: `Instant customer escrow refund for expired spiked quote ${quoteId}`,
        legs: [
          {
            accountCode: userEscrowCode,
            accountName: `User ${order.userId} Escrow`,
            accountType: 'LIABILITY',
            currency: order.currency,
            direction: 'DEBIT',
            amount: refundAmount,
          },
          {
            accountCode: payoutClearingCode,
            accountName: `${order.currency} Instant Payout Clearing`,
            accountType: 'ASSET',
            currency: order.currency,
            direction: 'CREDIT',
            amount: refundAmount,
          },
        ],
      });

      const updatedOrder = await tx.goldOrder.update({
        where: { id: order.id },
        data: { status: 'REFUNDED', requiredTopUpAmount: 0 },
      });

      return { order: updatedOrder, refundJournalId: refundJournal.id };
    });
  }
}
