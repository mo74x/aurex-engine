import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module';
import { LedgerModule } from '../ledger/ledger.module';
import { ProductCalculatorService } from './product-calculator.service';
import { PriceLockService } from './price-lock.service';
import { PaymentSettlementService } from './payment-settlement.service';
import { CheckoutController } from './checkout.controller';
import { PaymentWebhookController } from './payment-webhook.controller';

@Module({
  imports: [PricingModule, LedgerModule],
  controllers: [CheckoutController, PaymentWebhookController],
  providers: [
    ProductCalculatorService,
    PriceLockService,
    PaymentSettlementService,
  ],
  exports: [
    ProductCalculatorService,
    PriceLockService,
    PaymentSettlementService,
  ],
})
export class CheckoutModule {}
