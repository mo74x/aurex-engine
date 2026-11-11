import { Injectable, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

export interface CountryRule {
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';
  currency: 'EGP' | 'SAR' | 'AED' | 'OMR';
  decimals: number;
  effectiveFxRate: number;
  localMarketPremiumPct: number;
  askSpreadPct: number;
  bidSpreadPct: number;
}

const TROY_OUNCE_GRAMS = 31.1034768;
const TOLA_GRAMS = 11.6638038;

@Injectable()
export class PricingService implements OnModuleInit {
  private countryRules = new Map<string, CountryRule>();

  constructor(private readonly redisService: RedisService) {}

  onModuleInit() {
    // Load baseline configs into memory for sub-millisecond tick computation
    this.countryRules.set('EG', {
      countryCode: 'EG',
      currency: 'EGP',
      decimals: 2,
      effectiveFxRate: 50.25, // Synced from Sagha override or Admin API
      localMarketPremiumPct: 0.005,
      askSpreadPct: 0.004,
      bidSpreadPct: 0.006,
    });
    this.countryRules.set('SA', {
      countryCode: 'SA',
      currency: 'SAR',
      decimals: 2,
      effectiveFxRate: 3.75,
      localMarketPremiumPct: 0.002,
      askSpreadPct: 0.003,
      bidSpreadPct: 0.004,
    });
    this.countryRules.set('AE', {
      countryCode: 'AE',
      currency: 'AED',
      decimals: 2,
      effectiveFxRate: 3.6725,
      localMarketPremiumPct: 0.0015,
      askSpreadPct: 0.0025,
      bidSpreadPct: 0.0035,
    });
    this.countryRules.set('OM', {
      countryCode: 'OM',
      currency: 'OMR',
      decimals: 3, // Omani Baisa requires 3 decimal places
      effectiveFxRate: 0.3845,
      localMarketPremiumPct: 0.002,
      askSpreadPct: 0.003,
      bidSpreadPct: 0.004,
    });
  }

  public updateCountryRule(
    countryCode: 'EG' | 'SA' | 'AE' | 'OM',
    patch: Partial<Omit<CountryRule, 'countryCode' | 'currency' | 'decimals'>>,
  ) {
    const existing = this.countryRules.get(countryCode);
    if (!existing) return;

    this.countryRules.set(countryCode, {
      ...existing,
      ...patch,
    });
  }

  public getCountryRule(countryCode: string): CountryRule | undefined {
    return this.countryRules.get(countryCode.toUpperCase());
  }

  async processSpotTick(xauUsdBid: number, xauUsdAsk: number) {
    const redis = this.redisService.getClient();
    const pipeline = redis.pipeline();
    const timestamp = Date.now();

    for (const [code, rule] of this.countryRules.entries()) {
      const matrix = this.computeCountryMatrix(
        xauUsdBid,
        xauUsdAsk,
        rule,
        timestamp,
      );
      const payload = JSON.stringify(matrix);

      // 1. Store latest country snapshot with 15-second staleness TTL
      pipeline.set(`aurex:price:${code}`, payload, 'EX', 15);
      // 2. Publish to country-specific Pub/Sub channel
      pipeline.publish(`aurex:stream:${code}`, payload);
    }

    await pipeline.exec();
  }

  public computeCountryMatrix(
    xauBid: number,
    xauAsk: number,
    rule: CountryRule,
    timestamp: number,
  ) {
    const round = (val: number) => Number(val.toFixed(rule.decimals));

    const effectiveAskUsd =
      xauAsk * (1 + rule.localMarketPremiumPct) * (1 + rule.askSpreadPct);
    const effectiveBidUsd =
      xauBid * (1 + rule.localMarketPremiumPct) * (1 - rule.bidSpreadPct);

    const gram24kAsk =
      (effectiveAskUsd / TROY_OUNCE_GRAMS) * rule.effectiveFxRate;
    const gram24kBid =
      (effectiveBidUsd / TROY_OUNCE_GRAMS) * rule.effectiveFxRate;

    const karats = {
      '24K': { ask: round(gram24kAsk), bid: round(gram24kBid) },
      '22K': {
        ask: round(gram24kAsk * (22 / 24)),
        bid: round(gram24kBid * (22 / 24)),
      },
      '21K': {
        ask: round(gram24kAsk * (21 / 24)),
        bid: round(gram24kBid * (21 / 24)),
      },
      '18K': {
        ask: round(gram24kAsk * (18 / 24)),
        bid: round(gram24kBid * (18 / 24)),
      },
    };

    return {
      country: rule.countryCode,
      currency: rule.currency,
      timestamp,
      spotUsd: { bid: xauBid, ask: xauAsk },
      fxRate: rule.effectiveFxRate,
      karats,
      units: {
        goldPound8g21k: {
          ask: round(karats['21K'].ask * 8),
          bid: round(karats['21K'].bid * 8),
        },
        tola24k: {
          ask: round(karats['24K'].ask * TOLA_GRAMS),
          bid: round(karats['24K'].bid * TOLA_GRAMS),
        },
        ounce24k: {
          ask: round(effectiveAskUsd * rule.effectiveFxRate),
          bid: round(effectiveBidUsd * rule.effectiveFxRate),
        },
      },
    };
  }
}
