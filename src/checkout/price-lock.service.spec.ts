import { PriceLockService } from './price-lock.service';
import { ProductCalculatorService } from './product-calculator.service';
import { RedisService } from '../common/redis/redis.service';
import {
  BadRequestException,
  ConflictException,
  GoneException,
} from '@nestjs/common';

describe('PriceLockService', () => {
  let service: PriceLockService;
  let mockCalculator: any;
  let mockRedisClient: any;

  beforeEach(() => {
    mockCalculator = {
      calculateSkuPrice: jest
        .fn()
        .mockImplementation((sku: string, _qty: number) => {
          return Promise.resolve({
            sku,
            countryCode: 'EG',
            currency: 'EGP',
            lineTotalAsk: 45000,
          });
        }),
    };

    mockRedisClient = {
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      multi: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
      eval: jest.fn(),
    };

    const mockRedisService = {
      getClient: () => mockRedisClient,
    } as unknown as RedisService;

    service = new PriceLockService(
      mockCalculator as ProductCalculatorService,
      mockRedisService,
    );
  });

  it('should reject empty cart items', async () => {
    await expect(service.createPriceLock('u1', 'EG', [])).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should generate locked quote with HMAC signature and 5-min TTL', async () => {
    const quote = await service.createPriceLock('u1', 'EG', [
      { sku: 'EG-BTC-10G-24K', quantity: 1 },
    ]);

    expect(quote.quoteId).toMatch(/^q_/);
    expect(quote.userId).toBe('u1');
    expect(quote.countryCode).toBe('EG');
    expect(quote.currency).toBe('EGP');
    expect(quote.grandTotal).toBe(45000);
    expect(quote.status).toBe('ACTIVE');
    expect(quote.signature).toBeDefined();
    expect(quote.signature.length).toBe(64); // SHA-256 hex string
    expect(quote.ttlSeconds).toBe(300);
  });

  it('should reject consumption if quote is expired in Redis', async () => {
    mockRedisClient.eval.mockResolvedValue(
      JSON.stringify({ err: 'EXPIRED_OR_NOT_FOUND' }),
    );

    await expect(service.consumePriceLock('q_expired', 'u1')).rejects.toThrow(
      GoneException,
    );
  });

  it('should reject consumption if quote is already consumed', async () => {
    mockRedisClient.eval.mockResolvedValue(
      JSON.stringify({ err: 'ALREADY_CONSUMED' }),
    );

    await expect(
      service.consumePriceLock('q_already_used', 'u1'),
    ).rejects.toThrow(ConflictException);
  });

  it('should consume price lock token successfully', async () => {
    mockRedisClient.eval.mockResolvedValue(
      JSON.stringify({
        ok: {
          quoteId: 'q_valid',
          userId: 'u1',
          status: 'CONSUMED',
          grandTotal: 45000,
        },
      }),
    );

    const res = await service.consumePriceLock('q_valid', 'u1');
    expect(res.quoteId).toBe('q_valid');
    expect(res.status).toBe('CONSUMED');
  });
});
