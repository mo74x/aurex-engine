import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { PricingModule } from './pricing/pricing.module';
import { CheckoutModule } from './checkout/checkout.module';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    CommonModule,
    DatabaseModule,
    PricingModule,
    CheckoutModule,
    LedgerModule,
  ],
})
export class AppModule {}
