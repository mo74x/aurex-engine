import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ProductCalculatorService } from './product-calculator.service';
import { PriceLockService } from './price-lock.service';
import { VaultLedgerService } from '../ledger/vault-ledger.service';
import { CreatePriceLockDto, ConfirmOrderDto } from './dto/checkout.dto';

@Controller('api/checkout')
export class CheckoutController {
  constructor(
    private readonly calculator: ProductCalculatorService,
    private readonly priceLock: PriceLockService,
    private readonly vaultLedger: VaultLedgerService,
  ) {}

  // 1. Live SKU breakdown (e.g., GET /api/checkout/sku/EG-BTC-10G-24K?qty=2)
  @Get('sku/:sku')
  async getLiveSkuBreakdown(
    @Param('sku') sku: string,
    @Query('qty') qty?: string,
  ) {
    const quantity = qty ? Math.max(1, parseInt(qty, 10)) : 1;
    return this.calculator.calculateSkuPrice(sku, quantity);
  }

  // 2. Lock cart price for 5 minutes (POST /api/checkout/lock)
  @Post('lock')
  async lockCartPrice(@Body() body: CreatePriceLockDto) {
    return this.priceLock.createPriceLock(
      body.userId,
      body.countryCode,
      body.items,
    );
  }

  // 3. Confirm payment & consume lock directly from wallet/escrow balance (POST /api/checkout/confirm)
  @Post('confirm')
  async confirmOrder(@Body() body: ConfirmOrderDto) {
    const consumedQuote = await this.priceLock.consumePriceLock(
      body.quoteId,
      body.userId,
    );

    const settlement = await this.vaultLedger.settleDirectFromEscrow({
      quoteId: consumedQuote.quoteId,
      userId: consumedQuote.userId,
      countryCode: consumedQuote.countryCode,
      currency: consumedQuote.currency,
      grandTotal: consumedQuote.grandTotal,
      paymentReference: body.paymentReference,
      items: consumedQuote.items.map((i) => ({
        sku: i.sku,
        quantity: i.quantity,
      })),
    });

    return {
      status: 'ORDER_CONFIRMED',
      orderId: settlement.order.id,
      quoteId: settlement.order.quoteId,
      lockedGrandTotal: consumedQuote.grandTotal,
      currency: consumedQuote.currency,
      paymentReference: body.paymentReference,
      allocatedSerials: settlement.allocatedIngots.map((i) => i.serialNumber),
      confirmedAt: settlement.order.createdAt.toISOString(),
    };
  }
}
