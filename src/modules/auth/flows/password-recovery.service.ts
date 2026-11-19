import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/security/clock.js';
import { normalizeEmail } from '../../../common/validation/email.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailQueue } from '../../mail/mail-queue.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
import { SessionService } from '../session/session.service.js';
import { UserTokenService } from './user-token.service.js';

/** Forgot / reset password (plans/02-authentication.md §7.1, §8). */
@Injectable()
export class PasswordRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly hasher: PasswordHasher,
    private readonly tokens: UserTokenService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailQueue,
  ) {}

  /**
   * Never reveals whether the email has an account: the caller always answers
   * 202. Only an `active` user gets a token and an email.
   */
  async forgot(rawEmail: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(rawEmail) },
      select: { id: true, email: true, status: true },
    });
    if (!user || user.status !== 'active') return;

    await this.prisma.$transaction(async (tx) => {
      const token = await this.tokens.issue(tx, {
        userId: user.id,
        type: 'password_reset',
      });
      await this.mail.enqueue(tx, 'password_reset', { to: user.email, token });
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.password_reset_requested',
        userId: user.id,
      });
    });
    this.mail.notify();
  }

  /**
   * Sets a new password from an emailed token. Revokes EVERY session of the
   * user, clears the lockout, and queues the "password changed" notice. The
   * policy is checked before the token is consumed, so a weak password does
   * not burn the link.
   */
  async reset({
    token,
    newPassword,
  }: {
    token: string;
    newPassword: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.tokens.redeem(tx, {
        token,
        type: 'password_reset',
        userStatus: 'active',
        newPassword,
      });

      const now = this.clock.now();
      await tx.user.update({
        where: { id: user.id },
        data: {
          passwordHash: await this.hasher.hash(newPassword),
          passwordChangedAt: now,
          emailVerifiedAt: user.emailVerifiedAt ?? now,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      await this.sessions.revokeAllForUser(tx, {
        userId: user.id,
        reason: 'password_reset',
      });
      await this.mail.enqueue(tx, 'password_changed', { to: user.email });
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.password_reset',
        userId: user.id,
      });
    });
    this.mail.notify();
  }
}
