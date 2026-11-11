import {
  Injectable,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../database/prisma.service';

export interface SkuDefinition {
  sku: string;
  name: string;
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';
  karat: '24K' | '22K' | '21K' | '18K';
  weightGrams: number;
  makingFeePerGram: number; // Masna'eya + Damgha per gram
  cashbackPerGramSealed: number; // Refunded per gram if resold unopened
  cashbackPerGramOpened: number; // Refunded per gram if packaging is opened
  isInvestmentBullion: boolean; // True for >=99% (24K) bars
}

export interface CalculatedSkuQuote {
  sku: string;
  name: string;
  countryCode: string;
  currency: string;
  karat: string;
  weightGrams: number;
  quantity: number;
  spotUsdUsed: number;
  unitBreakdown: {
    rawGoldPricePerGram: number;
    makingFeePerGram: number;
    vatAmountPerUnit: number;
    unitTotalAsk: number;
    unitResaleBidSealed: number;
    unitResaleBidOpened: number;
  };
  lineTotalAsk: number;
  timestamp: number;
}

@Injectable()
export class ProductCalculatorService {
  // Built-in regional catalog (serves as immediate fallback and baseline)
  private readonly fallbackCatalog = new Map<string, SkuDefinition>([
    [
      'EG-BTC-10G-24K',
      {
        sku: 'EG-BTC-10G-24K',
        name: 'BTC 10g 24K Gold Ingot (Sealed)',
        countryCode: 'EG',
        karat: '24K',
        weightGrams: 10,
        makingFeePerGram: 68, // EGP per gram (includes stamp/damgha)
        cashbackPerGramSealed: 28, // 28 EGP/g cashback when sealed
        cashbackPerGramOpened: 11, // 11 EGP/g cashback if opened
        isInvestmentBullion: true,
      },
    ],
    [
      'EG-POUND-8G-21K',
      {
        sku: 'EG-POUND-8G-21K',
        name: 'King George Gold Pound 8g (21K)',
        countryCode: 'EG',
        karat: '21K',
        weightGrams: 8,
        makingFeePerGram: 55,
        cashbackPerGramSealed: 24,
        cashbackPerGramOpened: 11,
        isInvestmentBullion: false,
      },
    ],
    [
      'SA-PAMP-1OZ-24K',
      {
        sku: 'SA-PAMP-1OZ-24K',
        name: 'PAMP Suisse 1 oz 24K Lady Fortuna Bar',
        countryCode: 'SA',
        karat: '24K',
        weightGrams: 31.1035,
        makingFeePerGram: 4.5, // SAR per gram
        cashbackPerGramSealed: 1.5,
        cashbackPerGramOpened: 0,
        isInvestmentBullion: true,
      },
    ],
    [
      'AE-22K-COIN-8G',
      {
        sku: 'AE-22K-COIN-8G',
        name: 'Dubai 22K Sovereign Gold Coin (8g)',
        countryCode: 'AE',
        karat: '22K',
        weightGrams: 8,
        makingFeePerGram: 12.0, // AED per gram
        cashbackPerGramSealed: 3.0,
        cashbackPerGramOpened: 0,
        isInvestmentBullion: false,
      },
    ],
  ]);

  constructor(
    private readonly redisService: RedisService,
    private readonly prisma: PrismaService,
  ) {}

  async findSku(skuCode: string): Promise<SkuDefinition | null> {
    // 1. Check local catalog
    const local = this.fallbackCatalog.get(skuCode);
    if (local) return local;

    // 2. Query Prisma database
    try {
      const dbProduct = await this.prisma.goldProduct.findUnique({
        where: { sku: skuCode },
      });
      if (dbProduct) {
        const karatStr = `${dbProduct.karat}K` as '24K' | '22K' | '21K' | '18K';
        return {
          sku: dbProduct.sku,
          name: dbProduct.name,
          countryCode: dbProduct.countryCode as 'EG' | 'SA' | 'AE' | 'OM',
          karat: karatStr,
          weightGrams: Number(dbProduct.weightGrams),
          makingFeePerGram: Number(dbProduct.makingFeePerGram),
          cashbackPerGramSealed: Number(dbProduct.cashbackPerGram),
          cashbackPerGramOpened: 0,
          isInvestmentBullion: dbProduct.isInvestmentBullion,
        };
      }
    } catch {
      // Fallback if DB is unavailable
    }

    return null;
  }

  async calculateSkuPrice(
    skuCode: string,
    quantity = 1,
  ): Promise<CalculatedSkuQuote> {
    const product = await this.findSku(skuCode);
    if (!product) {
      throw new BadRequestException(`Unknown SKU: ${skuCode}`);
    }

    // 1. Fetch live country matrix from Redis
    const rawMatrix = await this.redisService
      .getClient()
      .get(`aurex:price:${product.countryCode}`);
    if (!rawMatrix) {
      throw new ServiceUnavailableException(
        `Live gold feed for ${product.countryCode} is stale or offline. Checkout paused for safety.`,
      );
    }

    const matrix = JSON.parse(rawMatrix);
    const decimals = product.countryCode === 'OM' ? 3 : 2;
    const karatRate = matrix.karats[product.karat];

    const weight = new Decimal(product.weightGrams);
    const askPerGram = new Decimal(karatRate.ask);
    const bidPerGram = new Decimal(karatRate.bid);
    const makingPerGram = new Decimal(product.makingFeePerGram);

    // 2. Metal + Making subtotal per unit
    const rawMetalUnit = weight.mul(askPerGram);
    const makingFeeUnit = weight.mul(makingPerGram);
    const subtotalUnit = rawMetalUnit.plus(makingFeeUnit);

    // 3. Apply Regional Tax & VAT Rules
    let vatUnit = new Decimal(0);
    if (product.countryCode === 'EG') {
      // Egypt: 14% VAT applies strictly to the making fee (Masna'eya + Damgha)
      vatUnit = makingFeeUnit.mul(new Decimal(0.14));
    } else if (product.countryCode === 'SA') {
      // KSA: 0% on >=99% investment bullion; 15% on jewelry / non-bullion
      vatUnit = product.isInvestmentBullion
        ? new Decimal(0)
        : subtotalUnit.mul(new Decimal(0.15));
    } else if (product.countryCode === 'AE' || product.countryCode === 'OM') {
      // UAE & Oman: 0% on >=99% investment bullion; 5% on jewelry / non-bullion
      vatUnit = product.isInvestmentBullion
        ? new Decimal(0)
        : subtotalUnit.mul(new Decimal(0.05));
    }

    const unitTotalAsk = subtotalUnit
      .plus(vatUnit)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

    // 4. Calculate Transparent Instant Buyback (Bid + Cashback)
    const unitResaleBidSealed = weight
      .mul(bidPerGram.plus(new Decimal(product.cashbackPerGramSealed)))
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

    const unitResaleBidOpened = weight
      .mul(bidPerGram.plus(new Decimal(product.cashbackPerGramOpened)))
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

    const lineTotalAsk = unitTotalAsk
      .mul(quantity)
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

    return {
      sku: product.sku,
      name: product.name,
      countryCode: product.countryCode,
      currency: matrix.currency,
      karat: product.karat,
      weightGrams: product.weightGrams,
      quantity,
      spotUsdUsed: matrix.spotUsd.ask,
      unitBreakdown: {
        rawGoldPricePerGram: askPerGram.toNumber(),
        makingFeePerGram: makingPerGram.toNumber(),
        vatAmountPerUnit: vatUnit.toDecimalPlaces(decimals).toNumber(),
        unitTotalAsk: unitTotalAsk.toNumber(),
        unitResaleBidSealed: unitResaleBidSealed.toNumber(),
        unitResaleBidOpened: unitResaleBidOpened.toNumber(),
      },
      lineTotalAsk: lineTotalAsk.toNumber(),
      timestamp: Date.now(),
    };
  }
}
