import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import type { TenantStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { PlatformActor } from './tenant-onboarding.service.js';

interface TransitionRule {
  /** Statuses the tenant may currently be in. */
  readonly from: readonly TenantStatus[];
  readonly to: TenantStatus;
  readonly action: string;
}

/**
 * Allowed transitions: active <-> suspended, and active|suspended -> deactivated.
 * Deactivation is one-way in Phase 2. No API deletes tenants. TenantGuard
 * enforces the new status on the next request.
 */
const TRANSITIONS = {
  suspend: {
    from: ['active'],
    to: 'suspended',
    action: 'tenant.suspended',
  },
  reactivate: {
    from: ['suspended'],
    to: 'active',
    action: 'tenant.reactivated',
  },
  deactivate: {
    from: ['active', 'suspended'],
    to: 'deactivated',
    action: 'tenant.deactivated',
  },
} as const satisfies Record<string, TransitionRule>;

@Injectable()
export class TenantLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  suspend(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(tenantId, TRANSITIONS.suspend, actor);
  }

  reactivate(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(tenantId, TRANSITIONS.reactivate, actor);
  }

  deactivate(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(tenantId, TRANSITIONS.deactivate, actor);
  }

  private async transition(
    tenantId: string,
    { from, to, action }: TransitionRule,
    actor: PlatformActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent transitions cannot both succeed.
      const { count } = await tx.tenant.updateMany({
        where: { id: tenantId, status: { in: [...from] } },
        data: { status: to },
      });
      if (count === 0) {
        const exists = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { id: true },
        });
        throw new DomainError(exists ? 'CONFLICT' : 'NOT_FOUND');
      }
      await this.audit.record(tx, {
        action,
        entityType: 'tenant',
        entityId: tenantId,
        tenantId,
        changedFields: ['status'],
        actorUserId: actor.userId,
        actorMembershipId: null,
      });
    });
  }
}
