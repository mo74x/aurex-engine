import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('AurexBootstrap');
  const app = await NestFactory.create(AppModule);

  // Global Input Validation & Schema Sanitization
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Standardized Error Response Filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Observability & Request Tracing Interceptor
  app.useGlobalInterceptors(new LoggingInterceptor());

  // CORS Configuration
  const corsOrigin = process.env.CORS_ORIGIN || '*';
  app.enableCors({
    origin: corsOrigin === '*' ? '*' : corsOrigin.split(','),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Enable graceful shutdown hooks so Redis & PostgreSQL connections close cleanly
  app.enableShutdownHooks();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(
    `Aurex Multi-Country Gold Engine running on http://localhost:${port}`,
  );
}
void bootstrap();
