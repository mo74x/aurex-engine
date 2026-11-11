import { Module, Global } from '@nestjs/common';
import { RedisService } from './redis.service';
import { PriceBroadcasterService } from './price-broadcaster.service';

@Global()
@Module({
  providers: [RedisService, PriceBroadcasterService],
  exports: [RedisService, PriceBroadcasterService],
})
export class RedisModule {}
