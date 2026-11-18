import { Injectable } from '@nestjs/common';
import type {
  MembershipStatus,
  TenantStatus,
  UserStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface ResolvedMembership {
  membershipId: string;
  membershipStatus: MembershipStatus;
  userStatus: UserStatus;
  tenantStatus: TenantStatus;
  /** Effective permission keys through membership_roles -> role_permissions. */
  permissions: string[];
}

export abstract class MembershipResolver {
  abstract resolve(
    tenantId: string,
    userId: string,
  ): Promise<ResolvedMembership | null>;
}

interface ResolvedRow {
  membership_id: string;
  membership_status: MembershipStatus;
  user_status: UserStatus;
  tenant_status: TenantStatus;
  permissions: string[];
}

/**
 * One indexed statement: the membership for (tenant, user) joined to its
 * tenant, user and effective permissions. Nothing is cached across requests,
 * so role and status changes apply on the next one. Uses the unscoped client
 * on purpose: this runs before a tenant has been verified. Parameters are
 * bound (tagged template), never concatenated.
 */
@Injectable()
export class PrismaMembershipResolver extends MembershipResolver {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async resolve(
    tenantId: string,
    userId: string,
  ): Promise<ResolvedMembership | null> {
    const rows = await this.prisma.$queryRaw<ResolvedRow[]>`
      SELECT m.id AS membership_id,
             m.status::text AS membership_status,
             u.status::text AS user_status,
             t.status::text AS tenant_status,
             COALESCE(
               array_agg(DISTINCT p.key) FILTER (WHERE p.key IS NOT NULL),
               ARRAY[]::text[]
             ) AS permissions
      FROM tenant_memberships m
      JOIN users u ON u.id = m.user_id
      JOIN tenants t ON t.id = m.tenant_id
      LEFT JOIN membership_roles mr
        ON mr.tenant_id = m.tenant_id AND mr.membership_id = m.id
      LEFT JOIN role_permissions rp
        ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
      LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE m.tenant_id = ${tenantId}::uuid AND m.user_id = ${userId}::uuid
      GROUP BY m.id, u.status, t.status`;
    const row = rows[0];
    if (!row) return null;
    return {
      membershipId: row.membership_id,
      membershipStatus: row.membership_status,
      userStatus: row.user_status,
      tenantStatus: row.tenant_status,
      permissions: row.permissions,
    };
  }
}
