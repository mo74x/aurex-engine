import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { SaghaCalibrationService } from './sagha-calibration.service';
import {
  Anchor21kDto,
  ManualSaghaFxDto,
  AutoCalibrationDto,
} from './dto/sagha-admin.dto';
import { AdminGuard } from '../common/guards/admin.guard';

@Controller('api/admin/sagha')
export class SaghaAdminController {
  constructor(private readonly saghaService: SaghaCalibrationService) {}

  // 1. Inspect current Sagha Dollar telemetry & spread over CBE
  @Get('status')
  async getSaghaStatus() {
    return this.saghaService.getCurrentState();
  }

  // 2. Pin Egypt's live price to a specific 21K EGP street price (e.g., 6280 EGP/g)
  @Post('anchor-21k')
  @UseGuards(AdminGuard)
  async pinTarget21kPrice(@Body() body: Anchor21kDto) {
    return this.saghaService.setTarget21kAnchor(
      body.target21kEgp,
      body.adminName || 'TRADING_DESK',
      body.askSpreadPct,
      body.bidSpreadPct,
    );
  }

  // 3. Directly lock the Sagha Dollar FX rate (e.g., 54.20 EGP)
  @Post('lock-fx')
  @UseGuards(AdminGuard)
  async lockManualSaghaFx(@Body() body: ManualSaghaFxDto) {
    return this.saghaService.setManualSaghaFxLock(
      body.saghaUsdEgp,
      body.adminName || 'TRADING_DESK',
      body.askSpreadPct,
      body.bidSpreadPct,
    );
  }

  // 4. Return to automated Sagha benchmark tracking
  @Post('auto')
  @UseGuards(AdminGuard)
  async enableAutoCalibration(@Body() body: AutoCalibrationDto) {
    return this.saghaService.resumeAutoCalibration(
      body.adminName || 'TRADING_DESK',
    );
  }
}
