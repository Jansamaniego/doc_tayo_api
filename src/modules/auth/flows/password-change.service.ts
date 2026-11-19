import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import { FIELD_ERROR_CODES } from '../../../common/errors/error-codes.js';
import { Clock } from '../../../common/security/clock.js';
import { RequestContext } from '../../../context/request-context.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { MailQueue } from '../../mail/mail-queue.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
import { assertPasswordPolicy } from '../password/password-policy.js';
import { SessionService } from '../session/session.service.js';

/** Change password for the signed-in user (POST /me/password). */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly context: RequestContext,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly mail: MailQueue,
  ) {}

  /** Keeps the CURRENT session, revokes every other one, queues the notice. */
  async change({
    currentPassword,
    newPassword,
  }: {
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const userId = this.context.requireUser();
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, passwordHash: true },
    });
    const matches = user.passwordHash
      ? await this.hasher.verify(user.passwordHash, currentPassword)
      : await this.hasher.verifyUnknown(currentPassword);
    if (!matches) {
      throw new DomainError('VALIDATION_FAILED', {
        details: [
          {
            field: 'currentPassword',
            code: 'PASSWORD_INCORRECT',
            message: FIELD_ERROR_CODES.PASSWORD_INCORRECT,
          },
        ],
      });
    }
    assertPasswordPolicy(newPassword, user.email);

    const passwordHash = await this.hasher.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, passwordChangedAt: this.clock.now() },
      });
      await this.sessions.revokeAllForUser(tx, {
        userId,
        reason: 'password_changed',
        exceptSessionId: this.context.sessionId,
      });
      await this.mail.enqueue(tx, 'password_changed', { to: user.email });
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.password_changed',
        userId,
      });
    });
    this.mail.notify();
  }
}
