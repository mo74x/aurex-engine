import {
  IsString,
  IsNotEmpty,
  IsIn,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  Max,
  IsPositive,
  IsNumber,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CartItemDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  quantity: number;
}

export class CreatePriceLockDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['EG', 'SA', 'AE', 'OM'])
  countryCode: 'EG' | 'SA' | 'AE' | 'OM';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items: CartItemDto[];
}

export class ConfirmOrderDto {
  @IsString()
  @IsNotEmpty()
  quoteId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsString()
  @IsNotEmpty()
  paymentReference: string;
}

export class EgyptIpnWebhookDto {
  @IsString()
  @IsNotEmpty()
  rrn: string;

  @IsString()
  @IsNotEmpty()
  quoteId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['EG_INSTAPAY', 'EG_VODAFONE_CASH'])
  method: 'EG_INSTAPAY' | 'EG_VODAFONE_CASH';

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amountEgp: number;

  @IsString()
  @IsNotEmpty()
  senderAddress: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  settledTimestampMs?: number;
}

export class GccGatewayWebhookDto {
  @IsString()
  @IsNotEmpty()
  gatewayTxId: string;

  @IsString()
  @IsNotEmpty()
  quoteId: string;

  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsIn(['SA_MADA', 'AE_APPLE_PAY', 'OM_OMANNET'])
  channel: 'SA_MADA' | 'AE_APPLE_PAY' | 'OM_OMANNET';

  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsIn(['SAR', 'AED', 'OMR'])
  currency: 'SAR' | 'AED' | 'OMR';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  settledTimestampMs?: number;
}
