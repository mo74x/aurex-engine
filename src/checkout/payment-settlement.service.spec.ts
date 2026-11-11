import { PaymentSettlementService } from './payment-settlement.service';
import { PriceLockService } from './price-lock.service';
import { ProductCalculatorService } from './product-calculator.service';
import { VaultLedgerService } from '../ledger/vault-ledger.service';
import { RedisService } from '../common/redis/redis.service';
import { ConflictException } from '@nestjs/common';

describe('PaymentSettlementService', () => {
  let service: PaymentSettlementService;
  let mockPriceLock: any;
  let mockCalculator: any;
  let mockVaultLedger: any;
  let mockRedisClient: any;

  beforeEach(() => {
    mockPriceLock = {
      acquireQuoteForWebhook: jest.fn(),
    };
    mockCalculator = {
      calculateSkuPrice: jest.fn(),
    };
    mockVaultLedger = {
      recordConfirmedOrderWithSerials: jest.fn().mockResolvedValue({}),
      holdLatePaymentInEscrow: jest.fn().mockResolvedValue({}),
    };

    mockRedisClient = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
    };

    const mockRedisService = {
      getClient: () => mockRedisClient,
    } as unknown as RedisService;

    service = new PaymentSettlementService(
      mockPriceLock as PriceLockService,
      mockCalculator as ProductCalculatorService,
      mockVaultLedger as VaultLedgerService,
      mockRedisService,
    );
  });

  it('should settle on-time payment via fast path (CONFIRMED_ON_TIME)', async () => {
    mockPriceLock.acquireQuoteForWebhook.mockResolvedValue({
      timing: 'ON_TIME',
      quote: {
        quoteId: 'q_123',
        userId: 'u_1',
        countryCode: 'EG',
        currency: 'EGP',
        grandTotal: 10000,
        items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
      },
    });

    const decision = await service.processVerifiedPayment({
      providerTxId: 'tx_ontime_1',
      quoteId: 'q_123',
      userId: 'u_1',
      channel: 'EG_INSTAPAY',
      paidAmount: 10000,
      paidCurrency: 'EGP',
    });

    expect(decision.orderStatus).toBe('CONFIRMED_ON_TIME');
    expect(decision.lockedGrandTotal).toBe(10000);
    expect(decision.absorbedCostByDealer).toBe(0);
    expect(mockVaultLedger.recordConfirmedOrderWithSerials).toHaveBeenCalled();
  });

  it('should absorb slippage if late payment slippage <= 0.35% (CONFIRMED_SLIPPAGE_ABSORBED)', async () => {
    mockPriceLock.acquireQuoteForWebhook.mockResolvedValue({
      timing: 'LATE_WITHIN_GRACE',
      quote: {
        quoteId: 'q_late_absorb',
        userId: 'u_1',
        countryCode: 'EG',
        currency: 'EGP',
        grandTotal: 10000,
        items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
      },
    });

    // Live price is 10025 (+0.25% slippage, which is <= 0.35%)
    mockCalculator.calculateSkuPrice.mockResolvedValue({
      lineTotalAsk: 10025,
    });

    const decision = await service.processVerifiedPayment({
      providerTxId: 'tx_late_absorb',
      quoteId: 'q_late_absorb',
      userId: 'u_1',
      channel: 'EG_INSTAPAY',
      paidAmount: 10000,
      paidCurrency: 'EGP',
    });

    expect(decision.orderStatus).toBe('CONFIRMED_SLIPPAGE_ABSORBED');
    expect(decision.slippagePct).toBe(0.25);
    expect(decision.absorbedCostByDealer).toBe(25);
    expect(decision.requiredTopUpAmount).toBe(0);
    expect(mockVaultLedger.recordConfirmedOrderWithSerials).toHaveBeenCalled();
  });

  it('should hold payment in escrow if slippage > 0.35% (HELD_IN_ESCROW_SLIPPAGE_EXCEEDED)', async () => {
    mockPriceLock.acquireQuoteForWebhook.mockResolvedValue({
      timing: 'LATE_WITHIN_GRACE',
      quote: {
        quoteId: 'q_late_spiked',
        userId: 'u_1',
        countryCode: 'EG',
        currency: 'EGP',
        grandTotal: 10000,
        items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
      },
    });

    // Live price is 10150 (+1.5% spike, which exceeds 0.35%)
    mockCalculator.calculateSkuPrice.mockResolvedValue({
      lineTotalAsk: 10150,
    });

    const decision = await service.processVerifiedPayment({
      providerTxId: 'tx_late_spiked',
      quoteId: 'q_late_spiked',
      userId: 'u_1',
      channel: 'EG_INSTAPAY',
      paidAmount: 10000,
      paidCurrency: 'EGP',
    });

    expect(decision.orderStatus).toBe('HELD_IN_ESCROW_SLIPPAGE_EXCEEDED');
    expect(decision.slippagePct).toBe(1.5);
    expect(decision.requiredTopUpAmount).toBe(150);
    expect(decision.resolutionOptions?.topUpUrl).toBe(
      '/api/checkout/escrow/q_late_spiked/top-up',
    );
    expect(decision.resolutionOptions?.instantRefundUrl).toBe(
      '/api/checkout/escrow/q_late_spiked/refund',
    );
    expect(mockVaultLedger.holdLatePaymentInEscrow).toHaveBeenCalled();
  });

  it('should hold underpaid transfers in escrow (HELD_IN_ESCROW_UNDERPAID)', async () => {
    mockPriceLock.acquireQuoteForWebhook.mockResolvedValue({
      timing: 'ON_TIME',
      quote: {
        quoteId: 'q_underpaid',
        userId: 'u_1',
        countryCode: 'EG',
        currency: 'EGP',
        grandTotal: 10000,
        items: [{ sku: 'EG-BTC-10G-24K', quantity: 1 }],
      },
    });

    const decision = await service.processVerifiedPayment({
      providerTxId: 'tx_underpaid',
      quoteId: 'q_underpaid',
      userId: 'u_1',
      channel: 'EG_INSTAPAY',
      paidAmount: 9000, // Shortfall of 1000
      paidCurrency: 'EGP',
    });

    expect(decision.orderStatus).toBe('HELD_IN_ESCROW_UNDERPAID');
    expect(decision.requiredTopUpAmount).toBe(1000);
    expect(
      mockVaultLedger.recordConfirmedOrderWithSerials,
    ).not.toHaveBeenCalled();
  });

  it('should prevent duplicate webhook processing via idempotency guard', async () => {
    mockRedisClient.set = jest.fn().mockResolvedValue(null); // Already exists!

    await expect(
      service.processVerifiedPayment({
        providerTxId: 'tx_duplicate',
        quoteId: 'q_dup',
        userId: 'u_1',
        channel: 'EG_INSTAPAY',
        paidAmount: 10000,
        paidCurrency: 'EGP',
      }),
    ).rejects.toThrow(ConflictException);
  });
});
