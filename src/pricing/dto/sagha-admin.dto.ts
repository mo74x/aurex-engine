import {
  IsNumber,
  IsPositive,
  Min,
  Max,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

export class Anchor21kDto {
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Min(1000)
  @Max(50000)
  target21kEgp: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  askSpreadPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  bidSpreadPct?: number;

  @IsOptional()
  @IsString()
  adminName?: string;
}

export class ManualSaghaFxDto {
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  @Min(10)
  @Max(250)
  saghaUsdEgp: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  askSpreadPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.1)
  bidSpreadPct?: number;

  @IsOptional()
  @IsString()
  adminName?: string;
}

export class AutoCalibrationDto {
  @IsOptional()
  @IsString()
  adminName?: string;
}
