import { ApiProperty } from '@nestjs/swagger';
import type { UserMembership } from '../user-memberships.service.js';

/** One clinic a user belongs to (login response and `GET /me/memberships`). */
export class MembershipResponse implements UserMembership {
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ example: 'Sunrise Clinic' }) tenantName!: string;
  @ApiProperty({ enum: ['active', 'suspended', 'deactivated'] })
  tenantStatus!: UserMembership['tenantStatus'];
  @ApiProperty({ enum: ['invited', 'active', 'suspended', 'removed'] })
  membershipStatus!: UserMembership['membershipStatus'];
  @ApiProperty({
    type: [String],
    example: ['Owner'],
    description: 'Display names of the roles held in that clinic.',
  })
  roles!: string[];
}

export class MembershipListEnvelope {
  @ApiProperty({ type: [MembershipResponse] }) data!: MembershipResponse[];
}
