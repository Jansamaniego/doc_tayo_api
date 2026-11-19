import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class SessionIdParams {
  @IsUUID() sessionId!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  currentPassword!: string;

  /** The password policy (length, common, email) is applied by the service. */
  @ApiProperty({ writeOnly: true })
  @IsString()
  @MaxLength(1024)
  newPassword!: string;
}
