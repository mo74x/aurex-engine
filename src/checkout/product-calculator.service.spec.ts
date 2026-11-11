import { ProductCalculatorService } from './product-calculator.service';
import { RedisService } from '../common/redis/redis.service';

describe('ProductCalculatorService', () => {
  let service: ProductCalculatorService;
  let mockRedisClient: any;
  let mockPrismaService: any;

  beforeEach(() => {
    mockRedisClient = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'aurex:price:EG') {
          return Promise.resolve(
            JSON.stringify({
              currency: 'EGP',
              spotUsd: { ask: 2750.0 },
              karats: {
                '24K': { ask: 4450.0, bid: 4420.0 },
                '21K': { ask: 3893.75, bid: 3867.5 },
              },
            }),
          );
        }
        if (key === 'aurex:price:SA') {
          return Promise.resolve(
            JSON.stringify({
              currency: 'SAR',
              spotUsd: { ask: 2750.0 },
              karats: {
                '24K': { ask: 332.0, bid: 329.5 },
              },
            }),
          );
        }
        if (key === 'aurex:price:AE') {
          return Promise.resolve(
            JSON.stringify({
              currency: 'AED',
              spotUsd: { ask: 2750.0 },
              karats: {
                '22K': { ask: 300.0, bid: 295.0 },
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

    mockPrismaService = {
      goldProduct: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    service = new ProductCalculatorService(mockRedisService, mockPrismaService);
  });

  it('should calculate Egyptian bullion price with 14% VAT strictly on making fee', async () => {
    // EG-BTC-10G-24K: weight 10g, making fee 68 EGP/g, ask = 4450.0 EGP/g
    const quote = await service.calculateSkuPrice('EG-BTC-10G-24K', 1);

    expect(quote.countryCode).toBe('EG');
    expect(quote.currency).toBe('EGP');

    // Raw metal = 10 * 4450 = 44,500
    // Making fee = 10 * 68 = 680
    // Subtotal = 45,180
    // VAT = 680 * 0.14 = 95.20
    // Total = 45,275.20
    expect(quote.unitBreakdown.rawGoldPricePerGram).toBe(4450.0);
    expect(quote.unitBreakdown.makingFeePerGram).toBe(68.0);
    expect(quote.unitBreakdown.vatAmountPerUnit).toBe(95.2);
    expect(quote.unitBreakdown.unitTotalAsk).toBe(45275.2);
    expect(quote.lineTotalAsk).toBe(45275.2);

    // Sealed resale cashback (28 EGP/g): 10 * (4420 + 28) = 44,480
    expect(quote.unitBreakdown.unitResaleBidSealed).toBe(44480.0);
    // Opened resale cashback (11 EGP/g): 10 * (4420 + 11) = 44,310
    expect(quote.unitBreakdown.unitResaleBidOpened).toBe(44310.0);
  });

  it('should apply 0% VAT on Saudi investment bullion (24K >=99%)', async () => {
    // SA-PAMP-1OZ-24K: 31.1035g, making fee 4.5 SAR/g, isInvestmentBullion = true
    const quote = await service.calculateSkuPrice('SA-PAMP-1OZ-24K', 1);

    expect(quote.countryCode).toBe('SA');
    expect(quote.currency).toBe('SAR');
    expect(quote.unitBreakdown.vatAmountPerUnit).toBe(0);
  });

  it('should apply 5% VAT on UAE non-bullion gold coin (22K <99%)', async () => {
    // AE-22K-COIN-8G: 8g, making fee 12.0 AED/g, ask = 300.0, isInvestmentBullion = false
    const quote = await service.calculateSkuPrice('AE-22K-COIN-8G', 1);

    expect(quote.countryCode).toBe('AE');
    // Raw metal = 8 * 300 = 2400
    // Making fee = 8 * 12 = 96
    // Subtotal = 2496
    // VAT = 2496 * 0.05 = 124.80
    // Total = 2620.80
    expect(quote.unitBreakdown.vatAmountPerUnit).toBe(124.8);
    expect(quote.unitBreakdown.unitTotalAsk).toBe(2620.8);
  });
});
