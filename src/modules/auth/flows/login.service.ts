import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { normalizeEmail } from '../../../common/validation/email.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import {
  UserMembershipsService,
  type UserMembership,
} from '../../tenancy/user-memberships.service.js';
import { AccessTokenService } from '../session/access-token.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
import {
  SessionService,
  type SessionMeta,
} from '../session/session.service.js';

/** Consecutive failed logins before the account locks (plans/02 §9.2). */
const LOCKOUT_THRESHOLD = 10;
/** Lock length. It expires on its own, which limits lockout-as-denial-of-service. */
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

export interface LoginResult {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  absoluteExpiresAt: Date;
  user: { id: string; email: string; fullName: string };
  memberships: UserMembership[];
  activeTenantId: string | null;
}

/**
 * Email + password login (plans/02-authentication.md §7.1, §9.2). Every
 * failure is the same INVALID_CREDENTIALS, and an unknown email costs the same
 * hashing time as a wrong password, so nothing reveals which accounts exist.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly accessTokens: AccessTokenService,
    private readonly audit: AuditService,
    private readonly memberships: UserMembershipsService,
  ) {}

  async login(
    rawEmail: string,
    password: string,
    meta: SessionMeta,
  ): Promise<LoginResult> {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        fullName: true,
        status: true,
        // Explicit select: the hash is omitted from every default query.
        passwordHash: true,
        lockedUntil: true,
      },
    });
    const now = this.clock.now();

    // Locked: answer exactly like the per-email throttle, before any hashing.
    if (user?.lockedUntil && user.lockedUntil > now) {
      throw new DomainError('RATE_LIMITED', {
        retryAfterSeconds: (user.lockedUntil.getTime() - now.getTime()) / 1000,
      });
    }

    const usable =
      user?.status === 'active' && user.passwordHash ? user : undefined;
    const matches = usable
      ? await this.hasher.verify(usable.passwordHash!, password)
      : await this.hasher.verifyUnknown(password);

    if (!usable || !matches) {
      // Only a real, active account has a failure counter and an audit trail.
      if (user?.status === 'active') await this.recordFailure(user.id, now);
      throw new DomainError('INVALID_CREDENTIALS');
    }

    const rehash = this.hasher.needsRehash(usable.passwordHash!)
      ? await this.hasher.hash(password)
      : undefined;
    const memberships = await this.memberships.list(usable.id);
    const active = memberships.filter(
      (m) => m.membershipStatus === 'active' && m.tenantStatus === 'active',
    );
    const activeTenantId = active.length === 1 ? active[0]!.tenantId : null;

    const session = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: usable.id },
        data: {
          failedLoginCount: 0,
          lockedUntil: null,
          ...(rehash ? { passwordHash: rehash } : {}),
        },
      });
      const created = await this.sessions.create(
        usable.id,
        { ...meta, activeTenantId },
        tx,
      );
      await this.audit.record(tx, {
        action: 'auth.login',
        entityType: 'user',
        entityId: usable.id,
        tenantId: null,
        actorUserId: usable.id,
        actorMembershipId: null,
      });
      return created;
    });

    const { token, expiresIn } = await this.accessTokens.sign(
      usable.id,
      session.sessionId,
    );
    return {
      accessToken: token,
      expiresIn,
      refreshToken: session.refreshToken,
      absoluteExpiresAt: session.absoluteExpiresAt,
      user: { id: usable.id, email: usable.email, fullName: usable.fullName },
      memberships,
      activeTenantId,
    };
  }

  /**
   * Counts one more consecutive failure and locks the account at the
   * threshold. The counter is not reset when a lock expires, so the next
   * failure locks again; only a success (or a password reset) clears it.
   */
  private async recordFailure(userId: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { failedLoginCount } = await tx.user.update({
        where: { id: userId },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      if (failedLoginCount >= LOCKOUT_THRESHOLD) {
        await tx.user.update({
          where: { id: userId },
          data: { lockedUntil: new Date(now.getTime() + LOCKOUT_DURATION_MS) },
        });
      }
      await this.audit.record(tx, {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: userId,
        tenantId: null,
        actorUserId: userId,
        actorMembershipId: null,
      });
    });
  }
}
