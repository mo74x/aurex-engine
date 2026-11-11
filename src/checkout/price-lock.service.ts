import {
  Injectable,
  BadRequestException,
  ConflictException,
  GoneException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import Decimal from 'decimal.js';
import {
  ProductCalculatorService,
  CalculatedSkuQuote,
} from './product-calculator.service';
import { RedisService } from '../common/redis/redis.service';

export interface LockedCheckoutQuote {
  quoteId: string;
  userId: string;
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';
  currency: string;
  items: CalculatedSkuQuote[];
  grandTotal: number;
  lockedAt: number;
  expiresAt: number;
  ttlSeconds: number;
  status: 'ACTIVE' | 'CONSUMED' | 'SETTLING_LATE';
  signature: string;
}

export interface QuoteAcquisitionResult {
  timing: 'ON_TIME' | 'LATE_WITHIN_GRACE';
  quote: LockedCheckoutQuote;
}

@Injectable()
export class PriceLockService {
  private readonly LOCK_TTL_SECONDS = 300; // 5 minutes
  private readonly HMAC_SECRET =
    process.env.QUOTE_HMAC_SECRET || 'aurex-super-secret-key';

  constructor(
    private readonly calculator: ProductCalculatorService,
    private readonly redisService: RedisService,
  ) {}

  async createPriceLock(
    userId: string,
    countryCode: 'EG' | 'SA' | 'AE' | 'OM',
    cartItems: Array<{ sku: string; quantity: number }>,
  ): Promise<LockedCheckoutQuote> {
    if (!cartItems || !cartItems.length) {
      throw new BadRequestException('Cart cannot be empty');
    }

    const redis = this.redisService.getClient();

    // 1. Calculate live prices for all SKUs in the cart
    const calculatedItems: CalculatedSkuQuote[] = [];
    let grandTotal = new Decimal(0);
    const decimals = countryCode === 'OM' ? 3 : 2;

    for (const item of cartItems) {
      if (item.quantity <= 0) {
        throw new BadRequestException('Item quantity must be greater than 0');
      }

      const skuQuote = await this.calculator.calculateSkuPrice(
        item.sku,
        item.quantity,
      );
      if (skuQuote.countryCode !== countryCode) {
        throw new BadRequestException(
          `SKU ${item.sku} belongs to ${skuQuote.countryCode}, not ${countryCode}`,
        );
      }
      calculatedItems.push(skuQuote);
      grandTotal = grandTotal.plus(new Decimal(skuQuote.lineTotalAsk));
    }

    const finalGrandTotal = grandTotal
      .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
      .toNumber();
    const quoteId = `q_${crypto.randomBytes(12).toString('hex')}`;
    const lockedAt = Date.now();
    const expiresAt = lockedAt + this.LOCK_TTL_SECONDS * 1000;

    // 2. Sign core financial fields so payload cannot be tampered with
    const signaturePayload = `${quoteId}:${userId}:${countryCode}:${finalGrandTotal}:${expiresAt}`;
    const signature = crypto
      .createHmac('sha256', this.HMAC_SECRET)
      .update(signaturePayload)
      .digest('hex');

    const quote: LockedCheckoutQuote = {
      quoteId,
      userId,
      countryCode,
      currency: calculatedItems[0].currency,
      items: calculatedItems,
      grandTotal: finalGrandTotal,
      lockedAt,
      expiresAt,
      ttlSeconds: this.LOCK_TTL_SECONDS,
      status: 'ACTIVE',
      signature,
    };

    // 3. Clear any previous active lock for this user (prevents tab-farming arbitrage)
    const userLockKey = `aurex:user_active_quote:${userId}`;
    const existingQuoteId = await redis.get(userLockKey);
    if (existingQuoteId) {
      await redis.del(`aurex:quote:${existingQuoteId}`);
    }

    // 4. Store new locked quote with strict 300-second TTL
    const GRACE_RETENTION_SECONDS = 3600;
    const multi = redis.multi();
    multi.set(
      `aurex:quote:${quoteId}`,
      JSON.stringify(quote),
      'EX',
      GRACE_RETENTION_SECONDS,
    );
    multi.set(userLockKey, quoteId, 'EX', this.LOCK_TTL_SECONDS);
    await multi.exec();

    return quote;
  }

  /**
   * Atomically verifies and consumes the 5-minute price-lock token using a Redis Lua script.
   * Ensures a quote can never be used twice or redeemed after expiration.
   */
  async consumePriceLock(
    quoteId: string,
    userId: string,
  ): Promise<LockedCheckoutQuote> {
    const redis = this.redisService.getClient();

    const luaScript = `
      local key = KEYS[1]
      local raw = redis.call('GET', key)
      if not raw then
        return cjson.encode({ err = 'EXPIRED_OR_NOT_FOUND' })
      end
      local quote = cjson.decode(raw)
      if quote.userId ~= ARGV[1] then
        return cjson.encode({ err = 'UNAUTHORIZED_USER' })
      end
      if quote.status ~= 'ACTIVE' then
        return cjson.encode({ err = 'ALREADY_CONSUMED' })
      end
      quote.status = 'CONSUMED'
      -- Keep record for 1 hour for audit/webhook reconciliation
      redis.call('SET', key, cjson.encode(quote), 'EX', 3600)
      return cjson.encode({ ok = quote })
    `;

    const rawResult = (await redis.eval(
      luaScript,
      1,
      `aurex:quote:${quoteId}`,
      userId,
    )) as string;

    const result = JSON.parse(rawResult || '{}') as {
      err?: string;
      ok?: LockedCheckoutQuote;
    };

    if (result?.err === 'EXPIRED_OR_NOT_FOUND') {
      throw new GoneException(
        'Your 5-minute price lock has expired. Please refresh your quote to lock the latest live gold price.',
      );
    }
    if (result?.err === 'ALREADY_CONSUMED') {
      throw new ConflictException(
        'This price-lock quote has already been used for an order.',
      );
    }
    if (result?.err === 'UNAUTHORIZED_USER' || !result?.ok) {
      throw new BadRequestException('Invalid checkout quote token.');
    }

    return result.ok;
  }

  async acquireQuoteForWebhook(
    quoteId: string,
    nowMs = Date.now(),
  ): Promise<QuoteAcquisitionResult> {
    const redis = this.redisService.getClient();

    const luaScript = `
      local key = KEYS[1]
      local now = tonumber(ARGV[1])
      local raw = redis.call('GET', key)
      if not raw then
        return cjson.encode({ err = 'QUOTE_NOT_FOUND' })
      end
      local quote = cjson.decode(raw)
      if quote.status ~= 'ACTIVE' then
        return cjson.encode({ err = 'ALREADY_PROCESSED:' .. quote.status })
      end

      local timing = 'ON_TIME'
      if now > tonumber(quote.expiresAt) then
        timing = 'LATE_WITHIN_GRACE'
        quote.status = 'SETTLING_LATE'
      else
        quote.status = 'CONSUMED'
      end

      redis.call('SET', key, cjson.encode(quote), 'EX', 86400)
      return cjson.encode({ ok = { timing = timing, quote = quote } })
    `;

    const rawResult = (await redis.eval(
      luaScript,
      1,
      `aurex:quote:${quoteId}`,
      nowMs.toString(),
    )) as string;

    const res = JSON.parse(rawResult || '{}') as {
      err?: string;
      ok?: QuoteAcquisitionResult;
    };

    if (res?.err) {
      throw new ConflictException(`Cannot settle quote ${quoteId}: ${res.err}`);
    }

    if (!res?.ok) {
      throw new ConflictException(
        `Cannot settle quote ${quoteId}: Invalid Lua response`,
      );
    }

    return res.ok;
  }
}
