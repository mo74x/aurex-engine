import { FractionalVaultService } from './fractional-vault.service';
import { PrismaService } from '../database/prisma.service';
import { VaultLedgerService } from './vault-ledger.service';
import { RedisService } from '../common/redis/redis.service';
import { BadRequestException, ConflictException } from '@nestjs/common';

describe('FractionalVaultService', () => {
  let service: FractionalVaultService;
  let mockPrisma: any;
  let mockVaultLedger: any;
  let mockRedisClient: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn((cb) => cb(mockPrisma)),
      physicalGoldIngot: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      ledgerAccount: {
        findUnique: jest.fn().mockResolvedValue({ balance: '100.0000' }),
      },
      goldVaultPosition: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'pos_1',
          totalGrams24k: '10.0000',
          weightedAvgCostPerG: '4400.0000',
          realizedPnl: '0.0000',
        }),
        upsert: jest.fn().mockResolvedValue({
          totalGrams24k: '1.0000',
          weightedAvgCostPerG: '4450.0000',
        }),
        update: jest.fn().mockResolvedValue({
          totalGrams24k: '8.0000',
        }),
      },
    };

    mockVaultLedger = {
      postBalancedJournal: jest.fn().mockResolvedValue({ id: 'j_1' }),
    };

    mockRedisClient = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'aurex:price:EG') {
          return Promise.resolve(
            JSON.stringify({
              currency: 'EGP',
              karats: {
                '24K': { ask: 4450.0, bid: 4420.0 },
              },
            }),
          );
        }
        return Promise.resolve(null);
      }),
    };

    const mockRedisService = {
      getClient: () => mockRedisClient,
    } as unknown as RedisService;

    service = new FractionalVaultService(
      mockPrisma as PrismaService,
      mockVaultLedger as VaultLedgerService,
      mockRedisService,
    );
  });

  it('should lock physical 24K bar into master fractional pool', async () => {
    mockPrisma.physicalGoldIngot.findUnique.mockResolvedValue({
      id: 'bar_1',
      serialNumber: 'BTC-24K-100G-001',
      status: 'AVAILABLE',
      karat: 24,
      weightGrams: '100.0000',
      countryCode: 'EG',
    });

    const res = await service.assignPhysicalBarToFractionalPool(
      'BTC-24K-100G-001',
      'VAULT_ADMIN',
    );

    expect(res.serialNumber).toBe('BTC-24K-100G-001');
    expect(res.addedGrams24k).toBe(100);
    expect(mockVaultLedger.postBalancedJournal).toHaveBeenCalled();
  });

  it('should reject non-24K or unavailable bars for fractional backing', async () => {
    mockPrisma.physicalGoldIngot.findUnique.mockResolvedValue({
      id: 'bar_2',
      serialNumber: 'EG-POUND-21K',
      status: 'AVAILABLE',
      karat: 21, // 21K cannot back 24K fractional pool!
      weightGrams: '8.0000',
      countryCode: 'EG',
    });

    await expect(
      service.assignPhysicalBarToFractionalPool('EG-POUND-21K', 'VAULT_ADMIN'),
    ).rejects.toThrow(BadRequestException);
  });

  it('should buy fractional 24K gold and update WAC position', async () => {
    const res = await service.buyFractionalGold({
      userId: 'u_1',
      countryCode: 'EG',
      gramsToBuy: 1.0,
      idempotencyKey: 'buy_1',
    });

    expect(res.action).toBe('BUY_FRACTIONAL_24K');
    expect(res.gramsPurchased).toBe(1.0);
    expect(res.executionAskPerGram).toBe(4450.0);
    expect(res.totalFiatDebited).toBe(4450.0);
    expect(mockVaultLedger.postBalancedJournal).toHaveBeenCalledTimes(2); // Fiat + Gold journals
  });

  it('should trigger slippage guard if ask price exceeds max acceptable', async () => {
    await expect(
      service.buyFractionalGold({
        userId: 'u_1',
        countryCode: 'EG',
        gramsToBuy: 1.0,
        maxAcceptableAskPerGram: 4400.0, // Live ask is 4450
        idempotencyKey: 'buy_slippage',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should sell fractional gold back to Aurex with liquidation fee and realized P&L', async () => {
    const res = await service.sellGoldInstantBuyback({
      userId: 'u_1',
      countryCode: 'EG',
      gramsToSell: 2.0,
      idempotencyKey: 'sell_1',
    });

    expect(res.action).toBe('INSTANT_DEALER_BUYBACK');
    expect(res.gramsSold).toBe(2.0);
    expect(res.executionBidPerGram).toBe(4420.0);
    // Gross: 2 * 4420 = 8840.0
    expect(res.grossProceeds).toBe(8840.0);
    // 0.15% Liquidation Fee: 8840 * 0.0015 = 13.26
    expect(res.liquidationFee).toBe(13.26);
    expect(res.netFiatCreditedToWallet).toBe(8826.74);
    // Cost basis: 2 * 4400 = 8800. Trade PnL = 8826.74 - 8800 = +26.74 EGP profit!
    expect(res.realizedPnlOnTrade).toBe(26.74);
  });
});
