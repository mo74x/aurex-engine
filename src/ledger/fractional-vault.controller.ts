import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FractionalVaultService } from './fractional-vault.service';
import {
  LoadMasterBarDto,
  BuyFractionalDto,
  SellFractionalDto,
} from './dto/ledger.dto';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api/vault/fractional')
export class FractionalVaultController {
  constructor(private readonly fractionalVault: FractionalVaultService) {}

  // 1. Admin locks a 24K physical bar into the Fractional Backing Pool (Admin protected)
  @Post('pool/load-bar')
  @UseGuards(AdminGuard)
  async loadMasterBar(@Body() body: LoadMasterBarDto) {
    return this.fractionalVault.assignPhysicalBarToFractionalPool(
      body.serialNumber,
      body.adminUser || 'VAULT_OFFICER',
    );
  }

  // 2. Customer buys fractional 24K grams from their fiat wallet/escrow
  @Post('buy')
  async buyFractional(@Body() body: BuyFractionalDto) {
    return this.fractionalVault.buyFractionalGold(body);
  }

  // 3. Customer sells fractional 24K grams back to Aurex instantly at live Bid
  @Post('sell-buyback')
  async sellInstantBuyback(@Body() body: SellFractionalDto) {
    return this.fractionalVault.sellGoldInstantBuyback(body);
  }

  // 4. Live portfolio valuation with real-time Bid price & Unrealized P&L
  @Get('portfolio/:userId')
  async getPortfolio(
    @Param('userId') userId: string,
    @Query('country') country: 'EG' | 'SA' | 'AE' | 'OM' = 'EG',
  ) {
    return this.fractionalVault.getLiveUserVaultPortfolio(userId, country);
  }
}
