import {
  Controller,
  Param,
  Sse,
  MessageEvent,
  Get,
  BadRequestException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PriceBroadcasterService } from '../common/redis/price-broadcaster.service';
import { RedisService } from '../common/redis/redis.service';

const VALID_COUNTRIES = new Set(['EG', 'SA', 'AE', 'OM']);

@Controller('api/prices')
export class PricingController {
  constructor(
    private readonly priceBroadcaster: PriceBroadcasterService,
    private readonly redisService: RedisService,
  ) {}

  @Get('latest/:country')
  async getLatestSnapshot(@Param('country') country: string) {
    const code = country.toUpperCase();
    if (!VALID_COUNTRIES.has(code)) {
      throw new BadRequestException('Unsupported country');
    }
    const cached = await this.redisService
      .getClient()
      .get(`aurex:price:${code}`);
    return cached ? JSON.parse(cached) : { status: 'STALE_FEED' };
  }

  /**
   * High-Performance Server-Sent Events Stream.
   * Multiplexed via PriceBroadcasterService: 100,000 clients share a single Redis subscription.
   */
  @Sse('stream/:country')
  streamCountryPrices(
    @Param('country') country: string,
  ): Observable<MessageEvent> {
    const code = country.toUpperCase();
    if (!VALID_COUNTRIES.has(code)) {
      throw new BadRequestException('Unsupported country');
    }

    return this.priceBroadcaster.getCountryStream(code).pipe(
      map((tickData) => ({
        data: tickData,
      })),
    );
  }
}
