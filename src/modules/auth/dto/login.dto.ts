import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'doctor@clinic.example' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Capped so an oversized body cannot be used to burn hashing time. */
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}

export class SwitchTenantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  tenantId!: string;
}

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ForgotPasswordDto {
  @ApiProperty({ example: 'doctor@clinic.example' })
  @Transform(trimString)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

/** The password policy (length, common, email) is applied by the service. */
export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the emailed link.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  token!: string;

  @ApiProperty({ writeOnly: true })
  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}

export class AccountSetupDto extends ResetPasswordDto {
  @ApiPropertyOptional()
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName?: string;
}

/**
 * `fullName` and `newPassword` are required only when the invited email has no
 * usable account yet; the service enforces that (an existing active user
 * sends the token alone).
 */
export class AcceptInvitationDto {
  @ApiProperty({ description: 'The token from the emailed link.' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  token!: string;

  @ApiPropertyOptional()
  @Transform(trimString)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({ writeOnly: true })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  newPassword?: string;
}
