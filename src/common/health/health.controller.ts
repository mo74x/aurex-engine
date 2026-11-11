import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import express from 'express';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../redis/redis.service';

@Controller('api/health')
export class HealthController {
  private readonly startTime = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  async checkHealth(@Res() res: express.Response) {
    const checks: Record<string, { status: 'UP' | 'DOWN'; details?: string }> =
      {};

    // 1. PostgreSQL Check
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = { status: 'UP' };
    } catch (err: any) {
      checks.database = { status: 'DOWN', details: err.message };
    }

    // 2. Redis Check
    try {
      const redisUp = await this.redisService.ping();
      checks.redis = { status: redisUp ? 'UP' : 'DOWN' };
    } catch (err: any) {
      checks.redis = { status: 'DOWN', details: err.message };
    }

    // 3. Market Feed Freshness Check
    try {
      const egPrice = await this.redisService.getClient().get('aurex:price:EG');
      if (egPrice) {
        const parsed = JSON.parse(egPrice);
        const ageMs = Date.now() - (parsed.timestamp || 0);
        checks.marketFeed = {
          status: ageMs < 30_000 ? 'UP' : 'DOWN',
          details: `Latest tick age: ${(ageMs / 1000).toFixed(1)}s`,
        };
      } else {
        checks.marketFeed = {
          status: 'DOWN',
          details: 'No active tick in cache',
        };
      }
    } catch (err: any) {
      checks.marketFeed = { status: 'DOWN', details: err.message };
    }

    const isHealthy = Object.values(checks).every((c) => c.status === 'UP');
    const statusCode = isHealthy
      ? HttpStatus.OK
      : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(statusCode).json({
      status: isHealthy ? 'HEALTHY' : 'DEGRADED',
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    });
  }
}
