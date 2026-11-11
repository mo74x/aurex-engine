import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service';
import { PricingController } from './pricing.controller';
import { SaghaCalibrationService } from './sagha-calibration.service';
import { SaghaAdminController } from './sagha-admin.controller';
import { XauStreamService } from '../ingestion/xau-stream.service';

@Module({
  controllers: [PricingController, SaghaAdminController],
  providers: [PricingService, SaghaCalibrationService, XauStreamService],
  exports: [PricingService, SaghaCalibrationService],
})
export class PricingModule {}
