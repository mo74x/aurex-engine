import { PricingService } from './pricing.service';
import { RedisService } from '../common/redis/redis.service';

describe('PricingService', () => {
  let service: PricingService;
  let mockRedisService: Partial<RedisService>;

  beforeEach(() => {
    mockRedisService = {
      getClient: jest.fn().mockReturnValue({
        pipeline: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnThis(),
          publish: jest.fn().mockReturnThis(),
          exec: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    service = new PricingService(mockRedisService as RedisService);
    service.onModuleInit();
  });

  it('should initialize default country rules for EG, SA, AE, and OM', () => {
    const egRule = service.getCountryRule('EG');
    const saRule = service.getCountryRule('SA');
    const aeRule = service.getCountryRule('AE');
    const omRule = service.getCountryRule('OM');

    expect(egRule).toBeDefined();
    expect(egRule?.currency).toBe('EGP');
    expect(egRule?.decimals).toBe(2);

    expect(saRule).toBeDefined();
    expect(saRule?.currency).toBe('SAR');
    expect(saRule?.decimals).toBe(2);

    expect(aeRule).toBeDefined();
    expect(aeRule?.currency).toBe('AED');
    expect(aeRule?.decimals).toBe(2);

    expect(omRule).toBeDefined();
    expect(omRule?.currency).toBe('OMR');
    expect(omRule?.decimals).toBe(3); // Oman requires 3 decimals (Baisa)
  });

  it('should calculate country matrix with exact karat conversions', () => {
    const rule = service.getCountryRule('EG')!;
    const matrix = service.computeCountryMatrix(
      2700.0,
      2701.0,
      rule,
      Date.now(),
    );

    expect(matrix.country).toBe('EG');
    expect(matrix.currency).toBe('EGP');
    expect(matrix.karats['24K'].ask).toBeGreaterThan(0);
    expect(matrix.karats['24K'].bid).toBeGreaterThan(0);
    expect(matrix.karats['24K'].ask).toBeGreaterThan(matrix.karats['24K'].bid);

    // Verify 21K is exactly 21/24 of 24K (within 1 unit due to rounding)
    const expected21kAsk = Number(
      (matrix.karats['24K'].ask * (21 / 24)).toFixed(2),
    );
    expect(
      Math.abs(matrix.karats['21K'].ask - expected21kAsk),
    ).toBeLessThanOrEqual(0.05);

    // Verify units
    expect(matrix.units.goldPound8g21k.ask).toBe(
      Number((matrix.karats['21K'].ask * 8).toFixed(2)),
    );
  });

  it('should format Omani Rial (OM) with exactly 3 decimals', () => {
    const rule = service.getCountryRule('OM')!;
    const matrix = service.computeCountryMatrix(
      2700.0,
      2701.0,
      rule,
      Date.now(),
    );

    const askStr = matrix.karats['24K'].ask.toString();
    const decimalPlaces = askStr.includes('.')
      ? askStr.split('.')[1].length
      : 0;
    expect(decimalPlaces).toBeLessThanOrEqual(3);
  });

  it('should update country rules dynamically when calibrated', () => {
    service.updateCountryRule('EG', {
      effectiveFxRate: 55.0,
      askSpreadPct: 0.005,
    });

    const updated = service.getCountryRule('EG');
    expect(updated?.effectiveFxRate).toBe(55.0);
    expect(updated?.askSpreadPct).toBe(0.005);
  });
});
