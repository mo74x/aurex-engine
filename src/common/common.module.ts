import { Module, Global } from '@nestjs/common';
import { RedisModule } from './redis/redis.module';
import { HealthController } from './health/health.controller';
import { AdminGuard } from './guards/admin.guard';
import { LoggingInterceptor } from './interceptors/logging.interceptor';
import { AllExceptionsFilter } from './filters/http-exception.filter';

@Global()
@Module({
  imports: [RedisModule],
  controllers: [HealthController],
  providers: [AdminGuard, LoggingInterceptor, AllExceptionsFilter],
  exports: [RedisModule, AdminGuard, LoggingInterceptor, AllExceptionsFilter],
})
export class CommonModule {}
