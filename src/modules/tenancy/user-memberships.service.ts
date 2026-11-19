import { Injectable } from '@nestjs/common';
import type {
  MembershipStatus,
  TenantStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface UserMembership {
  tenantId: string;
  tenantName: string;
  tenantStatus: TenantStatus;
  membershipStatus: MembershipStatus;
  /** Display names of the roles held in that tenant. */
  roles: string[];
}

/**
 * A user's memberships across ALL tenants (login response, /me/memberships).
 * Global identity data, so it uses the unscoped client on purpose; it never
 * returns anything that belongs to a tenant beyond its name and status.
 * Removed memberships are not listed.
 */
@Injectable()
export class UserMembershipsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<UserMembership[]> {
    const rows = await this.prisma.tenantMembership.findMany({
      where: { userId, status: { not: 'removed' } },
      select: {
        status: true,
        tenant: { select: { id: true, name: true, status: true } },
        roles: { select: { role: { select: { name: true } } } },
      },
      orderBy: [{ tenant: { name: 'asc' } }, { id: 'asc' }],
    });
    return rows.map((row) => ({
      tenantId: row.tenant.id,
      tenantName: row.tenant.name,
      tenantStatus: row.tenant.status,
      membershipStatus: row.status,
      roles: row.roles.map((r) => r.role.name).sort(),
    }));
  }
}
