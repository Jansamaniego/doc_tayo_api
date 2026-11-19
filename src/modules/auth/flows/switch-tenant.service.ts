import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import { RequestContext } from '../../../context/request-context.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MembershipResolver } from '../../tenancy/membership-resolver.js';
import { tenantAccessError } from '../../tenancy/tenant-access.js';

export interface SwitchTenantResult {
  activeTenantId: string;
  tenant: { id: string; name: string; status: string };
  /** Effective permission keys in that tenant. */
  permissions: string[];
}

/**
 * Changes the session's active tenant. The same access rule as TenantGuard
 * applies, so a user can only switch to a tenant they could already act in.
 * The change is stored on the session, so it takes effect on the very next
 * request with no new token (plans/02-authentication.md D5).
 */
@Injectable()
export class SwitchTenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: MembershipResolver,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  /** Switches the CALLER's current session (user and session come from the request context). */
  async switch({
    tenantId,
  }: {
    tenantId: string;
  }): Promise<SwitchTenantResult> {
    const userId = this.context.requireUser();
    const sessionId = this.context.sessionId!;
    const membership = await this.resolver.resolve(tenantId, userId);
    const denial = tenantAccessError(membership);
    if (denial || !membership) {
      throw new DomainError(denial ?? 'TENANT_ACCESS_DENIED');
    }

    const tenant = await this.prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: sessionId },
        data: { activeTenantId: tenantId },
      });
      await this.audit.record(tx, {
        action: 'auth.tenant_switched',
        entityType: 'session',
        entityId: sessionId,
        tenantId,
        actorUserId: userId,
        actorMembershipId: membership.membershipId,
      });
      return tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { id: true, name: true, status: true },
      });
    });
    return {
      activeTenantId: tenantId,
      tenant,
      permissions: [...membership.permissions].sort(),
    };
  }
}
