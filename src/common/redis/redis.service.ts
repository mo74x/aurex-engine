import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;
  private subscriberClient: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });

    this.subscriberClient = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      lazyConnect: true,
    });

    this.client.on('error', (err) => {
      this.logger.error(`Redis Main Client Error: ${err.message}`);
    });

    this.subscriberClient.on('error', (err) => {
      this.logger.error(`Redis Subscriber Client Error: ${err.message}`);
    });
  }

  async onModuleInit() {
    try {
      await Promise.all([
        this.client.connect(),
        this.subscriberClient.connect(),
      ]);
      this.logger.log(
        'Connected to Redis (Main & Subscriber pools initialized)',
      );
    } catch (err: any) {
      this.logger.warn(
        `Redis initial connect warning: ${err.message}. Reconnects scheduled.`,
      );
    }
  }

  getClient(): Redis {
    return this.client;
  }

  getSubscriber(): Redis {
    return this.subscriberClient;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy() {
    this.logger.log('Closing Redis connections gracefully...');
    await Promise.allSettled([
      this.client.quit(),
      this.subscriberClient.quit(),
    ]);
  }
}
