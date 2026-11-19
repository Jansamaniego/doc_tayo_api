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

export class MeProfileData {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt!: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  passwordChangedAt!: Date | null;
  @ApiProperty({ format: 'uuid', nullable: true }) activeTenantId!:
    string | null;
  @ApiProperty({
    type: [String],
    example: ['branches.read', 'tenant.read'],
    description:
      'Effective permissions in the active clinic (empty when none is selected or the membership is not active). Use them to build menus; the server enforces them regardless.',
  })
  permissions!: string[];
}
export class MeProfileEnvelope {
  @ApiProperty({ type: MeProfileData }) data!: MeProfileData;
}

export class SessionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) lastUsedAt!: Date;
  @ApiProperty({ nullable: true, type: String }) userAgent!: string | null;
  @ApiProperty({ nullable: true, type: String }) ip!: string | null;
  @ApiProperty({ description: 'True for the session making this request.' })
  current!: boolean;
}
export class SessionListEnvelope {
  @ApiProperty({ type: [SessionResponse] }) data!: SessionResponse[];
}
