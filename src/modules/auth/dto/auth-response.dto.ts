import { ApiProperty } from '@nestjs/swagger';
import { MembershipResponse } from '../../tenancy/dto/membership.dto.js';

export class UserSummary {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'doctor@clinic.example' }) email!: string;
  @ApiProperty() fullName!: string;
}

export class LoginData {
  @ApiProperty({
    description:
      'Send as `Authorization: Bearer <accessToken>`. Keep it in memory, not in storage.',
  })
  accessToken!: string;
  @ApiProperty({
    example: 900,
    description: 'Seconds until the access token expires.',
  })
  expiresIn!: number;
  @ApiProperty({ type: UserSummary }) user!: UserSummary;
  @ApiProperty({ type: [MembershipResponse] })
  memberships!: MembershipResponse[];
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Chosen automatically when the user has exactly one active membership in an active clinic; otherwise null and the client calls switch-tenant.',
  })
  activeTenantId!: string | null;
}
export class LoginEnvelope {
  @ApiProperty({ type: LoginData }) data!: LoginData;
}

export class RefreshData {
  @ApiProperty() accessToken!: string;
  @ApiProperty({ example: 900 }) expiresIn!: number;
}
export class RefreshEnvelope {
  @ApiProperty({ type: RefreshData }) data!: RefreshData;
}

export class TenantSummary {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'deactivated'] })
  status!: string;
}

export class SwitchTenantData {
  @ApiProperty({ format: 'uuid' }) activeTenantId!: string;
  @ApiProperty({ type: TenantSummary }) tenant!: TenantSummary;
  @ApiProperty({
    type: [String],
    example: ['branches.read', 'tenant.read'],
    description: 'Effective permission keys in that clinic.',
  })
  permissions!: string[];
}
export class SwitchTenantEnvelope {
  @ApiProperty({ type: SwitchTenantData }) data!: SwitchTenantData;
}

export class AcceptedData {
  @ApiProperty({ example: true }) accepted!: boolean;
}
export class AcceptedEnvelope {
  @ApiProperty({ type: AcceptedData }) data!: AcceptedData;
}
