import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import {
  PaymentSettlementService,
  IncomingPaymentEvent,
} from './payment-settlement.service';
import { EgyptIpnWebhookDto, GccGatewayWebhookDto } from './dto/checkout.dto';

@Controller('api/webhooks/payments')
export class PaymentWebhookController {
  private readonly WEBHOOK_SECRET =
    process.env.PAYMENT_WEBHOOK_SECRET || 'aurex-webhook-secret-key';

  constructor(private readonly settlementService: PaymentSettlementService) {}

  private verifyWebhookHmac(rawPayload: string, signature?: string) {
    if (!signature || typeof signature !== 'string') {
      throw new UnauthorizedException('Missing payment webhook signature');
    }

    const expected = crypto
      .createHmac('sha256', this.WEBHOOK_SECRET)
      .update(rawPayload)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);

    if (
      sigBuf.length !== expBuf.length ||
      !crypto.timingSafeEqual(sigBuf, expBuf)
    ) {
      throw new UnauthorizedException('Invalid payment webhook HMAC signature');
    }
  }

  /**
   * 1. Egypt Instant Payment Webhook (InstaPay / Vodafone Cash IPN)
   * POST /api/webhooks/payments/egypt-ipn
   */
  @Post('egypt-ipn')
  async handleEgyptInstantPayment(
    @Headers('x-aurex-signature') signature: string,
    @Body() payload: EgyptIpnWebhookDto,
  ) {
    this.verifyWebhookHmac(JSON.stringify(payload), signature);

    const event: IncomingPaymentEvent = {
      providerTxId: `EG_${payload.rrn}`,
      quoteId: payload.quoteId,
      userId: payload.userId,
      channel: payload.method,
      paidAmount: payload.amountEgp,
      paidCurrency: 'EGP',
      payerIdentifier: payload.senderAddress,
      paidAtMs: payload.settledTimestampMs || Date.now(),
    };

    return this.settlementService.processVerifiedPayment(event);
  }

  /**
   * 2. GCC Unified Card & Apple Pay Webhook (KSA Mada, UAE Apple Pay, OmanNet)
   * POST /api/webhooks/payments/gcc-gateway
   */
  @Post('gcc-gateway')
  async handleGccGatewayWebhook(
    @Headers('x-aurex-signature') signature: string,
    @Body() payload: GccGatewayWebhookDto,
  ) {
    this.verifyWebhookHmac(JSON.stringify(payload), signature);

    return this.settlementService.processVerifiedPayment({
      providerTxId: `GCC_${payload.gatewayTxId}`,
      quoteId: payload.quoteId,
      userId: payload.userId,
      channel: payload.channel,
      paidAmount: payload.amount,
      paidCurrency: payload.currency,
      paidAtMs: payload.settledTimestampMs || Date.now(),
    });
  }
}
