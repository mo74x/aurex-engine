import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { PriceLockService, LockedCheckoutQuote } from './price-lock.service';
import { ProductCalculatorService } from './product-calculator.service';
import { VaultLedgerService } from '../ledger/vault-ledger.service';
import { RedisService } from '../common/redis/redis.service';

export type PaymentChannel =
  | 'EG_INSTAPAY'
  | 'EG_VODAFONE_CASH'
  | 'SA_MADA'
  | 'AE_APPLE_PAY'
  | 'OM_OMANNET';

export interface IncomingPaymentEvent {
  providerTxId: string; // Unique reference (e.g., InstaPay RRN or Gateway ID)
  quoteId: string;
  userId: string;
  channel: PaymentChannel;
  paidAmount: number;
  paidCurrency: 'EGP' | 'SAR' | 'AED' | 'OMR';
  payerIdentifier?: string; // e.g., user@instapay or +2010xxxxxxxx
  paidAtMs?: number;
}

export interface SettlementDecision {
  orderStatus:
    | 'CONFIRMED_ON_TIME'
    | 'CONFIRMED_LATE_NO_SLIPPAGE'
    | 'CONFIRMED_SLIPPAGE_ABSORBED'
    | 'HELD_IN_ESCROW_SLIPPAGE_EXCEEDED'
    | 'HELD_IN_ESCROW_UNDERPAID';
  quoteId: string;
  providerTxId: string;
  channel: PaymentChannel;
  currency: string;
  lockedGrandTotal: number;
  liveRecalculatedTotal: number;
  paidAmount: number;
  slippagePct: number;
  absorbedCostByDealer: number;
  requiredTopUpAmount: number;
  resolutionOptions?: {
    topUpUrl: string;
    instantRefundUrl: string;
    topUpLockExpiresInSeconds: number;
  };
  settledAt: string;
}

@Injectable()
export class PaymentSettlementService {
  private readonly logger = new Logger(PaymentSettlementService.name);

  // Dealer absorbs up to 0.35% upward gold movement on late InstaPay/Vodafone Cash transfers
  private readonly MAX_ABSORBABLE_SLIPPAGE_PCT = new Decimal('0.35');

  constructor(
    private readonly priceLock: PriceLockService,
    private readonly calculator: ProductCalculatorService,
    private readonly vaultLedger: VaultLedgerService,
    private readonly redisService: RedisService,
  ) {}

  async processVerifiedPayment(
    event: IncomingPaymentEvent,
  ): Promise<SettlementDecision> {
    const redis = this.redisService.getClient();

    // 1. Idempotency Guard: Ensure the same webhook/InstaPay RRN is never processed twice
    const idempotencyKey = `aurex:webhook:tx:${event.providerTxId}`;
    const isFirstSeen = await redis.set(
      idempotencyKey,
      'PROCESSING',
      'EX',
      86400 * 7,
      'NX',
    );
    if (!isFirstSeen) {
      const existingResult = await redis.get(`${idempotencyKey}:result`);
      if (existingResult) return JSON.parse(existingResult);
      throw new ConflictException(
        `Transaction ${event.providerTxId} is already being processed.`,
      );
    }

    // 2. Atomically acquire the quote and check if it arrived ON_TIME or LATE_WITHIN_GRACE
    const { timing, quote } = await this.priceLock.acquireQuoteForWebhook(
      event.quoteId,
      event.paidAtMs || Date.now(),
    );

    if (quote.currency !== event.paidCurrency) {
      throw new BadRequestException(
        `Currency mismatch: expected ${quote.currency}, received ${event.paidCurrency}`,
      );
    }

    const decimals = quote.countryCode === 'OM' ? 3 : 2;
    const lockedTotal = new Decimal(quote.grandTotal);
    const paidAmount = new Decimal(event.paidAmount);

    // 3. Verify the user didn't underpay the locked quote on a manual InstaPay transfer
    if (paidAmount.lt(lockedTotal)) {
      const shortfall = lockedTotal
        .minus(paidAmount)
        .toDecimalPlaces(decimals)
        .toNumber();
      const decision: SettlementDecision = {
        orderStatus: 'HELD_IN_ESCROW_UNDERPAID',
        quoteId: quote.quoteId,
        providerTxId: event.providerTxId,
        channel: event.channel,
        currency: quote.currency,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: lockedTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        slippagePct: 0,
        absorbedCostByDealer: 0,
        requiredTopUpAmount: shortfall,
        settledAt: new Date().toISOString(),
      };
      await this.persistDecision(idempotencyKey, decision);
      return decision;
    }

    // 4. Fast Path: Webhook arrived within the 5-minute lock window
    if (timing === 'ON_TIME') {
      const liveTotal = lockedTotal;
      const decision: SettlementDecision = {
        orderStatus: 'CONFIRMED_ON_TIME',
        quoteId: quote.quoteId,
        providerTxId: event.providerTxId,
        channel: event.channel,
        currency: quote.currency,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: lockedTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        slippagePct: 0,
        absorbedCostByDealer: 0,
        requiredTopUpAmount: 0,
        settledAt: new Date().toISOString(),
      };
      await this.vaultLedger.recordConfirmedOrderWithSerials({
        quoteId: quote.quoteId,
        userId: quote.userId,
        countryCode: quote.countryCode,
        currency: quote.currency,
        providerTxId: event.providerTxId,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: liveTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        absorbedCostByDealer: decision.absorbedCostByDealer,
        items: quote.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      });
      await this.persistDecision(idempotencyKey, decision);
      return decision;
    }

    // 5. Late Path: Payment arrived after the 5-minute lock expired.
    // Recalculate the exact cart at the current live gold price tick.
    const liveTotal = await this.recalculateCartAtCurrentTick(quote, decimals);
    const priceDiff = liveTotal.minus(lockedTotal);
    const slippagePct = priceDiff
      .div(lockedTotal)
      .mul(100)
      .toDecimalPlaces(3, Decimal.ROUND_HALF_UP);

    this.logger.warn(
      `[LATE PAYMENT] Quote ${quote.quoteId} via ${event.channel}. Locked: ${lockedTotal}, Live: ${liveTotal} (${slippagePct}% slippage)`,
    );

    // Case 5A: Gold price dropped or stayed flat since the user locked the quote
    if (slippagePct.lte(0)) {
      const decision: SettlementDecision = {
        orderStatus: 'CONFIRMED_LATE_NO_SLIPPAGE',
        quoteId: quote.quoteId,
        providerTxId: event.providerTxId,
        channel: event.channel,
        currency: quote.currency,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: liveTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        slippagePct: slippagePct.toNumber(),
        absorbedCostByDealer: 0,
        requiredTopUpAmount: 0,
        settledAt: new Date().toISOString(),
      };
      await this.vaultLedger.recordConfirmedOrderWithSerials({
        quoteId: quote.quoteId,
        userId: quote.userId,
        countryCode: quote.countryCode,
        currency: quote.currency,
        providerTxId: event.providerTxId,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: liveTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        absorbedCostByDealer: decision.absorbedCostByDealer,
        items: quote.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      });
      await this.persistDecision(idempotencyKey, decision);
      return decision;
    }

    // Case 5B: Gold rose slightly, but within our 0.35% dealer slippage buffer
    if (slippagePct.lte(this.MAX_ABSORBABLE_SLIPPAGE_PCT)) {
      const decision: SettlementDecision = {
        orderStatus: 'CONFIRMED_SLIPPAGE_ABSORBED',
        quoteId: quote.quoteId,
        providerTxId: event.providerTxId,
        channel: event.channel,
        currency: quote.currency,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: liveTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        slippagePct: slippagePct.toNumber(),
        absorbedCostByDealer: priceDiff.toDecimalPlaces(decimals).toNumber(),
        requiredTopUpAmount: 0,
        settledAt: new Date().toISOString(),
      };
      await this.vaultLedger.recordConfirmedOrderWithSerials({
        quoteId: quote.quoteId,
        userId: quote.userId,
        countryCode: quote.countryCode,
        currency: quote.currency,
        providerTxId: event.providerTxId,
        lockedGrandTotal: lockedTotal.toNumber(),
        liveRecalculatedTotal: liveTotal.toNumber(),
        paidAmount: paidAmount.toNumber(),
        absorbedCostByDealer: decision.absorbedCostByDealer,
        items: quote.items.map((i) => ({ sku: i.sku, quantity: i.quantity })),
      });
      await this.persistDecision(idempotencyKey, decision);
      return decision;
    }

    // Case 5C: Gold spiked > 0.35% after quote expiry. Hold funds in escrow & offer Top-Up or Refund.
    const topUpRequired = liveTotal
      .minus(paidAmount)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();

    // Create a 10-minute Top-Up lock in Redis so the user can pay just the difference
    await redis.set(
      `aurex:escrow_topup:${quote.quoteId}`,
      JSON.stringify({
        quoteId: quote.quoteId,
        userId: quote.userId,
        alreadyPaid: paidAmount.toNumber(),
        newTargetTotal: liveTotal.toNumber(),
        topUpRequired,
        currency: quote.currency,
      }),
      'EX',
      600,
    );

    const decision: SettlementDecision = {
      orderStatus: 'HELD_IN_ESCROW_SLIPPAGE_EXCEEDED',
      quoteId: quote.quoteId,
      providerTxId: event.providerTxId,
      channel: event.channel,
      currency: quote.currency,
      lockedGrandTotal: lockedTotal.toNumber(),
      liveRecalculatedTotal: liveTotal.toNumber(),
      paidAmount: paidAmount.toNumber(),
      slippagePct: slippagePct.toNumber(),
      absorbedCostByDealer: 0,
      requiredTopUpAmount: topUpRequired,
      resolutionOptions: {
        topUpUrl: `/api/checkout/escrow/${quote.quoteId}/top-up`,
        instantRefundUrl: `/api/checkout/escrow/${quote.quoteId}/refund`,
        topUpLockExpiresInSeconds: 600,
      },
      settledAt: new Date().toISOString(),
    };

    await this.vaultLedger.holdLatePaymentInEscrow({
      quoteId: quote.quoteId,
      userId: quote.userId,
      countryCode: quote.countryCode,
      currency: quote.currency,
      providerTxId: event.providerTxId,
      lockedGrandTotal: lockedTotal.toNumber(),
      liveRecalculatedTotal: liveTotal.toNumber(),
      paidAmount: paidAmount.toNumber(),
      requiredTopUpAmount: topUpRequired,
    });

    await this.persistDecision(idempotencyKey, decision);
    return decision;
  }

  private async recalculateCartAtCurrentTick(
    quote: LockedCheckoutQuote,
    decimals: number,
  ): Promise<Decimal> {
    let liveGrandTotal = new Decimal(0);
    for (const item of quote.items) {
      const freshQuote = await this.calculator.calculateSkuPrice(
        item.sku,
        item.quantity,
      );
      liveGrandTotal = liveGrandTotal.plus(
        new Decimal(freshQuote.lineTotalAsk),
      );
    }
    return liveGrandTotal.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
  }

  private async persistDecision(
    idempotencyKey: string,
    decision: SettlementDecision,
  ) {
    await this.redisService
      .getClient()
      .set(
        `${idempotencyKey}:result`,
        JSON.stringify(decision),
        'EX',
        86400 * 7,
      );
  }
}
