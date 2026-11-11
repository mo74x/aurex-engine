import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsInt,
  Min,
  Max,
  IsPositive,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CartItemDto } from '../../checkout/dto/checkout.dto';

export class SeedVaultDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  count?: number;
}

export class TopUpEscrowDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  topUpTxId: string;

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  topUpPaidAmount: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

export class RefundEscrowDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}

export class LoadMasterBarDto {
  @IsString()
  @IsNotEmpty()
  serialNumber: string;

  @IsOptional()
  @IsString()
  adminUser?: string;
}

export class BuyFractionalDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['EG', 'SA', 'AE', 'OM'])
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  gramsToBuy?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  fiatAmountToSpend?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  maxAcceptableAskPerGram?: number;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}

export class SellFractionalDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['EG', 'SA', 'AE', 'OM'])
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  gramsToSell: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  minAcceptableBidPerGram?: number;

  @IsString()
  @IsNotEmpty()
  idempotencyKey: string;
}
