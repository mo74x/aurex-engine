import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import WebSocket from 'ws';
import { PricingService } from '../pricing/pricing.service';

@Injectable()
export class XauStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XauStreamService.name);
  private ws: WebSocket | null = null;
  private simulatorInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isDestroyed = false;

  constructor(private readonly pricingService: PricingService) {}

  onModuleInit() {
    if (process.env.TWELVEDATA_API_KEY) {
      this.connectLiveWebSocket();
    } else {
      this.logger.warn(
        'No TWELVEDATA_API_KEY found — starting 1-second XAU/USD simulator',
      );
      this.startLocalSimulator();
    }
  }

  private connectLiveWebSocket() {
    if (this.isDestroyed) return;

    const apiKey = process.env.TWELVEDATA_API_KEY;
    const url = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${apiKey}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this.logger.log('Connected to upstream XAU/USD WebSocket feed');
        this.ws?.send(
          JSON.stringify({
            action: 'subscribe',
            params: { symbols: 'XAU/USD' },
          }),
        );
      });

      this.ws.on('message', (raw: WebSocket.RawData) => {
        void (async () => {
          try {
            const rawStr = Buffer.isBuffer(raw)
              ? raw.toString('utf-8')
              : Buffer.from(raw as ArrayBuffer).toString('utf-8');
            const data = JSON.parse(rawStr);
            if (data.event === 'price' && data.symbol === 'XAU/USD') {
              const midPrice = Number(data.price);
              if (!isNaN(midPrice) && midPrice > 0) {
                const bid = Number((midPrice - 0.15).toFixed(2));
                const ask = Number((midPrice + 0.15).toFixed(2));
                await this.pricingService.processSpotTick(bid, ask);
              }
            }
          } catch (err: any) {
            this.logger.warn(
              `Failed to parse upstream price tick: ${err.message}`,
            );
          }
        })();
      });

      this.ws.on('error', (err) => {
        this.logger.error(`Upstream WebSocket feed error: ${err.message}`);
      });

      this.ws.on('close', () => {
        if (this.isDestroyed) return;
        this.logger.warn('Upstream WebSocket closed. Reconnecting in 3s...');
        this.reconnectTimer = setTimeout(
          () => this.connectLiveWebSocket(),
          3000,
        );
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to initiate WebSocket connection: ${err.message}`,
      );
      if (!this.isDestroyed) {
        this.reconnectTimer = setTimeout(
          () => this.connectLiveWebSocket(),
          5000,
        );
      }
    }
  }

  private startLocalSimulator() {
    let baseSpot = 2745.5;
    this.simulatorInterval = setInterval(() => {
      void (async () => {
        // Simulate realistic micro-ticks every second (-$0.40 to +$0.40)
        const delta = (Math.random() - 0.495) * 0.8;
        baseSpot = Number((baseSpot + delta).toFixed(2));
        await this.pricingService.processSpotTick(
          Number((baseSpot - 0.2).toFixed(2)),
          Number((baseSpot + 0.2).toFixed(2)),
        );
      })();
    }, 1000);
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.simulatorInterval) clearInterval(this.simulatorInterval);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // Ignore close error during teardown
      }
    }
  }
}
