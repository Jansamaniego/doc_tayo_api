import { ApiProperty } from '@nestjs/swagger';
import type {
  RoleSummary,
  UserMembership,
} from '../user-memberships.service.js';

export class RoleSummaryResponse implements RoleSummary {
  @ApiProperty({
    example: 'owner',
    description: 'Stable machine key; use it in code, not the name.',
  })
  key!: string;
  @ApiProperty({ example: 'Owner', description: 'Display name for the UI.' })
  name!: string;
}

/** One clinic a user belongs to (login response and `GET /me/memberships`). */
export class MembershipResponse implements UserMembership {
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ example: 'Sunrise Clinic' }) tenantName!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'deactivated'] })
  tenantStatus!: UserMembership['tenantStatus'];
  @ApiProperty({ enum: ['invited', 'active', 'suspended', 'removed'] })
  membershipStatus!: UserMembership['membershipStatus'];
  @ApiProperty({
    type: [RoleSummaryResponse],
    description: 'Roles held in that clinic.',
  })
  roles!: RoleSummaryResponse[];
}

export class MembershipListEnvelope {
  @ApiProperty({ type: [MembershipResponse] }) data!: MembershipResponse[];
}
