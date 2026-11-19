import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { Clock } from '../../common/security/clock.js';
import { RequestContext } from '../../context/request-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session/session.service.js';
import { MembershipResolver } from '../tenancy/membership-resolver.js';
import { tenantAccessError } from '../tenancy/tenant-access.js';
import {
  UserMembershipsService,
  type UserMembership,
} from '../tenancy/user-memberships.service.js';

export interface MeProfile {
  id: string;
  email: string;
  fullName: string;
  emailVerifiedAt: Date | null;
  passwordChangedAt: Date | null;
  activeTenantId: string | null;
  /** Effective permissions in the active tenant (empty when none or not active). */
  permissions: string[];
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

/** The signed-in user's own account (global identity, never tenant data). */
@Injectable()
export class MeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    private readonly resolver: MembershipResolver,
    private readonly memberships: UserMembershipsService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async profile(): Promise<MeProfile> {
    const userId = this.context.requireUser();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        emailVerifiedAt: true,
        passwordChangedAt: true,
      },
    });
    const activeTenantId = this.context.activeTenantId ?? null;
    let permissions: string[] = [];
    if (activeTenantId) {
      const membership = await this.resolver.resolve(activeTenantId, userId);
      if (membership && tenantAccessError(membership) === null) {
        permissions = [...membership.permissions].sort();
      }
    }
    return { ...user, activeTenantId, permissions };
  }

  listMemberships(): Promise<UserMembership[]> {
    return this.memberships.list(this.context.requireUser());
  }

  async listSessions(): Promise<SessionSummary[]> {
    const now = this.clock.now();
    const rows = await this.prisma.session.findMany({
      where: {
        userId: this.context.requireUser(),
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        userAgent: true,
        ip: true,
      },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
    });
    const current = this.context.sessionId;
    return rows.map((row) => ({ ...row, current: row.id === current }));
  }

  /** Revokes one of the CALLER's sessions; anyone else's is a plain 404. */
  async revokeSession(sessionId: string): Promise<void> {
    const userId = this.context.requireUser();
    await this.prisma.$transaction(async (tx) => {
      const own = await tx.session.findFirst({
        where: { id: sessionId, userId, revokedAt: null },
        select: { id: true },
      });
      if (!own) throw new DomainError('NOT_FOUND');
      await this.sessions.revoke(sessionId, 'logout', tx);
      await this.audit.record(tx, {
        action: 'auth.session_revoked',
        entityType: 'session',
        entityId: sessionId,
        tenantId: null,
        actorUserId: userId,
        actorMembershipId: null,
      });
    });
  }
}
