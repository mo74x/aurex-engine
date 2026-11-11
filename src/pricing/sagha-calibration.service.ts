import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  BadRequestException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { PricingService } from './pricing.service';
import { RedisService } from '../common/redis/redis.service';

export type EgCalibrationMode =
  'AUTO_CALIBRATE' | 'TARGET_21K_ANCHOR' | 'MANUAL_FX_LOCK';

export interface EgSaghaState {
  mode: EgCalibrationMode;
  officialCbeUsdEgp: number; // Official Central Bank USD/EGP rate
  impliedSaghaUsdEgp: number; // Calculated or overridden Gold Dollar rate
  localSagha21kBenchmark: number; // Local 21K street price per gram in EGP
  spotXauUsdReference: number; // Spot XAU/USD at calibration moment
  impliedSpreadOverCbePct: number; // % difference between Sagha USD & Official USD
  askSpreadPct: number;
  bidSpreadPct: number;
  maxAllowedDriftPct: number; // Circuit breaker threshold (e.g., 0.05 = 5%)
  updatedBy: string;
  updatedAt: number;
}

const TROY_OUNCE_GRAMS = new Decimal('31.1034768');

@Injectable()
export class SaghaCalibrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SaghaCalibrationService.name);
  private calibrationTimer: NodeJS.Timeout | null = null;
  private readonly REDIS_STATE_KEY = 'aurex:sagha:state:EG';

  constructor(
    private readonly pricingService: PricingService,
    private readonly redisService: RedisService,
  ) {}

  async onModuleInit() {
    const redis = this.redisService.getClient();

    // Initialize default Egypt Sagha state if not already persisted in Redis
    const existing = await redis.get(this.REDIS_STATE_KEY);
    if (!existing) {
      const initialState: EgSaghaState = {
        mode: 'AUTO_CALIBRATE',
        officialCbeUsdEgp: 52.85,
        impliedSaghaUsdEgp: 53.99,
        localSagha21kBenchmark: 6275.75,
        spotXauUsdReference: 4108.69,
        impliedSpreadOverCbePct: 2.16,
        askSpreadPct: 0.004,
        bidSpreadPct: 0.006,
        maxAllowedDriftPct: 0.06, // 6% max divergence circuit breaker
        updatedBy: 'SYSTEM_INIT',
        updatedAt: Date.now(),
      };
      await this.saveAndBroadcastState(initialState);
    } else {
      const parsed: EgSaghaState = JSON.parse(existing);
      this.syncToPricingEngine(parsed);
    }

    // Run automated Sagha calibration check every 30 seconds
    this.calibrationTimer = setInterval(() => {
      void this.runAutoCalibrationCycle();
    }, 30_000);
  }

  /**
   * Reverse-calculates the implied Sagha USD/EGP rate from a local 21K EGP gram price
   * and the current live international XAU/USD spot price.
   */
  calculateImpliedSaghaUsd(local21kEgp: number, spotXauUsd: number): number {
    const price21k = new Decimal(local21kEgp);
    const spot = new Decimal(spotXauUsd);

    // 1. Convert 21K EGP gram to 24K EGP gram: price21k * (24 / 21)
    const implied24kEgp = price21k.mul(24).div(21);

    // 2. Implied Ounce in EGP = implied24kEgp * 31.1034768
    const impliedOunceEgp = implied24kEgp.mul(TROY_OUNCE_GRAMS);

    // 3. Implied Sagha USD = impliedOunceEgp / spotXauUsd
    return impliedOunceEgp
      .div(spot)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toNumber();
  }

  /**
   * Mode 1: Automated background calibration against local Egyptian gold market benchmarks
   */
  async runAutoCalibrationCycle() {
    const state = await this.getCurrentState();
    if (state.mode !== 'AUTO_CALIBRATE') return;

    try {
      const redis = this.redisService.getClient();
      const latestEgTick = await redis.get('aurex:price:EG');
      const currentSpotUsd = latestEgTick
        ? JSON.parse(latestEgTick).spotUsd.ask
        : state.spotXauUsdReference;

      const { local21kAskEgp, officialCbeUsd } =
        this.fetchExternalEgyptBenchmarks(
          currentSpotUsd,
          state.officialCbeUsdEgp,
        );

      const impliedSaghaUsd = this.calculateImpliedSaghaUsd(
        local21kAskEgp,
        currentSpotUsd,
      );
      const spreadOverCbe = (impliedSaghaUsd - officialCbeUsd) / officialCbeUsd;

      // Circuit Breaker: Reject anomalous spikes if benchmark feed returns corrupted data
      if (Math.abs(spreadOverCbe) > state.maxAllowedDriftPct) {
        this.logger.warn(
          `[SAGHA CIRCUIT BREAKER] Implied Sagha USD (${impliedSaghaUsd}) drifted ${(
            spreadOverCbe * 100
          ).toFixed(
            2,
          )}% from CBE (${officialCbeUsd}). Holding previous safe rate.`,
        );
        return;
      }

      const updated: EgSaghaState = {
        ...state,
        officialCbeUsdEgp: officialCbeUsd,
        impliedSaghaUsdEgp: impliedSaghaUsd,
        localSagha21kBenchmark: local21kAskEgp,
        spotXauUsdReference: currentSpotUsd,
        impliedSpreadOverCbePct: Number((spreadOverCbe * 100).toFixed(2)),
        updatedBy: 'AUTO_CALIBRATOR',
        updatedAt: Date.now(),
      };

      await this.saveAndBroadcastState(updated);
    } catch (err: any) {
      this.logger.error('Failed to run auto-calibration cycle', err?.message);
    }
  }

  /**
   * Mode 2: Admin pins a target 21K EGP street price (e.g., 6,275 EGP/g).
   */
  async setTarget21kAnchor(
    target21kEgp: number,
    adminUser: string,
    askSpreadPct?: number,
    bidSpreadPct?: number,
  ): Promise<EgSaghaState> {
    if (target21kEgp <= 1000 || target21kEgp >= 50000) {
      throw new BadRequestException(
        'Target 21K EGP price is outside realistic bounds.',
      );
    }

    const state = await this.getCurrentState();
    const redis = this.redisService.getClient();
    const latestEgTick = await redis.get('aurex:price:EG');
    const currentSpotUsd = latestEgTick
      ? JSON.parse(latestEgTick).spotUsd.ask
      : state.spotXauUsdReference;

    const newAskSpread = askSpreadPct ?? state.askSpreadPct;

    const rawTargetBeforeSpread = target21kEgp / (1 + newAskSpread);
    const impliedSaghaUsd = this.calculateImpliedSaghaUsd(
      rawTargetBeforeSpread,
      currentSpotUsd,
    );

    const spreadOverCbe =
      ((impliedSaghaUsd - state.officialCbeUsdEgp) / state.officialCbeUsdEgp) *
      100;

    const updated: EgSaghaState = {
      ...state,
      mode: 'TARGET_21K_ANCHOR',
      impliedSaghaUsdEgp: impliedSaghaUsd,
      localSagha21kBenchmark: target21kEgp,
      spotXauUsdReference: currentSpotUsd,
      impliedSpreadOverCbePct: Number(spreadOverCbe.toFixed(2)),
      askSpreadPct: newAskSpread,
      bidSpreadPct: bidSpreadPct ?? state.bidSpreadPct,
      updatedBy: adminUser,
      updatedAt: Date.now(),
    };

    await this.saveAndBroadcastState(updated);
    return updated;
  }

  /**
   * Mode 3: Admin directly locks the Sagha Dollar FX rate (e.g., 54.15 EGP)
   */
  async setManualSaghaFxLock(
    manualSaghaUsdEgp: number,
    adminUser: string,
    askSpreadPct?: number,
    bidSpreadPct?: number,
  ): Promise<EgSaghaState> {
    if (manualSaghaUsdEgp <= 10 || manualSaghaUsdEgp >= 250) {
      throw new BadRequestException(
        'Manual Sagha USD/EGP rate is out of bounds.',
      );
    }

    const state = await this.getCurrentState();
    const redis = this.redisService.getClient();
    const latestEgTick = await redis.get('aurex:price:EG');
    const currentSpotUsd = latestEgTick
      ? JSON.parse(latestEgTick).spotUsd.ask
      : state.spotXauUsdReference;

    const effectiveAskSpread = askSpreadPct ?? state.askSpreadPct;

    const resulting21kEgp = Number(
      (
        (currentSpotUsd / 31.1034768) *
        manualSaghaUsdEgp *
        (21 / 24) *
        (1 + effectiveAskSpread)
      ).toFixed(2),
    );

    const spreadOverCbe =
      ((manualSaghaUsdEgp - state.officialCbeUsdEgp) /
        state.officialCbeUsdEgp) *
      100;

    const updated: EgSaghaState = {
      ...state,
      mode: 'MANUAL_FX_LOCK',
      impliedSaghaUsdEgp: manualSaghaUsdEgp,
      localSagha21kBenchmark: resulting21kEgp,
      spotXauUsdReference: currentSpotUsd,
      impliedSpreadOverCbePct: Number(spreadOverCbe.toFixed(2)),
      askSpreadPct: effectiveAskSpread,
      bidSpreadPct: bidSpreadPct ?? state.bidSpreadPct,
      updatedBy: adminUser,
      updatedAt: Date.now(),
    };

    await this.saveAndBroadcastState(updated);
    return updated;
  }

  async resumeAutoCalibration(adminUser: string): Promise<EgSaghaState> {
    const state = await this.getCurrentState();
    const updated: EgSaghaState = {
      ...state,
      mode: 'AUTO_CALIBRATE',
      updatedBy: adminUser,
      updatedAt: Date.now(),
    };
    await this.saveAndBroadcastState(updated);
    await this.runAutoCalibrationCycle();
    return this.getCurrentState();
  }

  async getCurrentState(): Promise<EgSaghaState> {
    const redis = this.redisService.getClient();
    const raw = await redis.get(this.REDIS_STATE_KEY);
    return JSON.parse(raw!);
  }

  private async saveAndBroadcastState(state: EgSaghaState) {
    const redis = this.redisService.getClient();
    await redis.set(this.REDIS_STATE_KEY, JSON.stringify(state));
    await redis.lpush('aurex:sagha:audit_log', JSON.stringify(state));
    await redis.ltrim('aurex:sagha:audit_log', 0, 199);

    this.syncToPricingEngine(state);
  }

  private syncToPricingEngine(state: EgSaghaState) {
    this.pricingService.updateCountryRule('EG', {
      effectiveFxRate: state.impliedSaghaUsdEgp,
      localMarketPremiumPct: 0,
      askSpreadPct: state.askSpreadPct,
      bidSpreadPct: state.bidSpreadPct,
    });
  }

  private fetchExternalEgyptBenchmarks(
    currentSpotUsd: number,
    fallbackCbeUsd: number,
  ): { local21kAskEgp: number; officialCbeUsd: number } {
    const simulatedSaghaFx = fallbackCbeUsd * 1.018;
    const simulated21k = Number(
      ((currentSpotUsd / 31.1034768) * simulatedSaghaFx * (21 / 24)).toFixed(2),
    );
    return {
      local21kAskEgp: simulated21k,
      officialCbeUsd: fallbackCbeUsd,
    };
  }

  onModuleDestroy() {
    if (this.calibrationTimer) clearInterval(this.calibrationTimer);
  }
}
