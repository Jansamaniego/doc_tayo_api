import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import type { TenantStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { PlatformActor } from './tenant-onboarding.service.js';

/**
 * Allowed transitions: active <-> suspended, and active|suspended -> deactivated.
 * Deactivation is one-way in Phase 2. No API deletes tenants. TenantGuard
 * enforces the new status on the next request.
 */
@Injectable()
export class TenantLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  suspend(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(
      tenantId,
      ['active'],
      'suspended',
      'tenant.suspended',
      actor,
    );
  }

  reactivate(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(
      tenantId,
      ['suspended'],
      'active',
      'tenant.reactivated',
      actor,
    );
  }

  deactivate(tenantId: string, actor: PlatformActor): Promise<void> {
    return this.transition(
      tenantId,
      ['active', 'suspended'],
      'deactivated',
      'tenant.deactivated',
      actor,
    );
  }

  private async transition(
    tenantId: string,
    from: TenantStatus[],
    to: TenantStatus,
    action: string,
    actor: PlatformActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent transitions cannot both succeed.
      const { count } = await tx.tenant.updateMany({
        where: { id: tenantId, status: { in: from } },
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
