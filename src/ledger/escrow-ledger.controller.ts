import { Controller, Post, Get, Param, Body, UseGuards } from '@nestjs/common';
import * as crypto from 'crypto';
import { VaultLedgerService } from './vault-ledger.service';
import { PrismaService } from '../database/prisma.service';
import {
  SeedVaultDto,
  TopUpEscrowDto,
  RefundEscrowDto,
} from './dto/ledger.dto';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api/checkout/escrow')
export class EscrowLedgerController {
  constructor(
    private readonly vaultLedger: VaultLedgerService,
    private readonly prisma: PrismaService,
  ) {}

  // 1. Seed serialized physical gold bars into the Cairo & Riyadh vaults (Admin protected)
  @Post('seed-vault')
  @UseGuards(AdminGuard)
  async seedPhysicalVaultBars(@Body() body: SeedVaultDto) {
    const count = body.count || 10;
    const created: string[] = [];

    for (let i = 1; i <= count; i++) {
      const serial = `BTC-EG-24K-10G-${String(100000 + i)}`;
      const certHash = crypto.createHash('sha256').update(serial).digest('hex');
      await this.prisma.physicalGoldIngot.upsert({
        where: { serialNumber: serial },
        update: {},
        create: {
          serialNumber: serial,
          sku: 'EG-BTC-10G-24K',
          countryCode: 'EG',
          vaultLocation: 'CAIRO_SAGHA_VAULT_1',
          karat: 24,
          weightGrams: 10,
          assayCertHash: certHash,
          status: 'AVAILABLE',
        },
      });
      created.push(serial);
    }

    return { seededCount: created.length, sampleSerials: created.slice(0, 3) };
  }

  // 2. Customer chooses Option A: Pay Top-Up Difference & Claim Serialized Ingot
  @Post(':quoteId/top-up')
  async resolveEscrowByTopUp(
    @Param('quoteId') quoteId: string,
    @Body() body: TopUpEscrowDto,
  ) {
    return this.vaultLedger.topUpEscrowAndAllocate({
      quoteId,
      userId: body.userId,
      topUpTxId: body.topUpTxId,
      topUpPaidAmount: body.topUpPaidAmount,
      items: body.items,
    });
  }

  // 3. Customer chooses Option B: Instant 1-Click Escrow Refund
  @Post(':quoteId/refund')
  async resolveEscrowByRefund(
    @Param('quoteId') quoteId: string,
    @Body() body: RefundEscrowDto,
  ) {
    return this.vaultLedger.refundEscrowOrder(quoteId, body.userId);
  }

  // 4. Inspect full Double-Entry Audit Trail & Account Balances for a Quote
  @Get(':quoteId/audit')
  async getQuoteLedgerAudit(@Param('quoteId') quoteId: string) {
    const order = await this.prisma.goldOrder.findUnique({
      where: { quoteId },
      include: { allocatedIngots: true },
    });
    const journals = await this.prisma.journalTransaction.findMany({
      where: { referenceId: quoteId },
      include: {
        entries: {
          include: { account: true },
        },
      },
      orderBy: { postedAt: 'asc' },
    });
    return { order, journals };
  }
}
