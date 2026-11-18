import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IsTimeZone } from '../../../common/validation/is-time-zone.decorator.js';
import { Trim } from '../../../common/validation/trim.js';

/** Editable clinic settings. `slug` and `status` are deliberately absent. */
export class UpdateTenantDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @Trim()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 'Asia/Manila' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsTimeZone()
  timezone?: string;

  @ApiPropertyOptional({ nullable: true, maxLength: 254 })
  @Trim()
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '+639171234567' })
  @Trim()
  @IsOptional()
  @Matches(/^\+[1-9]\d{6,14}$/)
  contactPhone?: string | null;
}

export class TenantResponse {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'deactivated'] })
  status!: string;
  @ApiProperty({ example: 'Asia/Manila' }) timezone!: string;
  @ApiProperty({ nullable: true, type: String }) contactEmail!: string | null;
  @ApiProperty({ nullable: true, type: String }) contactPhone!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class TenantEnvelope {
  @ApiProperty({ type: TenantResponse }) data!: TenantResponse;
}

export function toTenantResponse(row: TenantResponse): TenantResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    timezone: row.timezone,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
