import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { RedisService } from './redis.service';

const MONITORED_CHANNELS = [
  'aurex:stream:EG',
  'aurex:stream:SA',
  'aurex:stream:AE',
  'aurex:stream:OM',
];

@Injectable()
export class PriceBroadcasterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceBroadcasterService.name);
  private subjects = new Map<string, Subject<any>>();

  constructor(private readonly redisService: RedisService) {
    for (const code of ['EG', 'SA', 'AE', 'OM']) {
      this.subjects.set(code, new Subject<any>());
    }
  }

  async onModuleInit() {
    const subscriber = this.redisService.getSubscriber();

    try {
      await subscriber.subscribe(...MONITORED_CHANNELS);
      this.logger.log(
        `Subscribed to Redis channels: ${MONITORED_CHANNELS.join(', ')}`,
      );
    } catch (err: any) {
      this.logger.error(`Failed to subscribe to Redis streams: ${err.message}`);
    }

    subscriber.on('message', (channel: string, message: string) => {
      try {
        const country = channel.replace('aurex:stream:', '').toUpperCase();
        const subject = this.subjects.get(country);
        if (subject) {
          const parsed = JSON.parse(message);
          subject.next(parsed);
        }
      } catch (err: any) {
        this.logger.error(
          `Error parsing message from channel ${channel}: ${err.message}`,
        );
      }
    });
  }

  getCountryStream(countryCode: string): Observable<any> {
    const code = countryCode.toUpperCase();
    let subject = this.subjects.get(code);
    if (!subject) {
      subject = new Subject<any>();
      this.subjects.set(code, subject);
    }
    return subject.asObservable();
  }

  onModuleDestroy() {
    for (const subject of this.subjects.values()) {
      subject.complete();
    }
  }
}
