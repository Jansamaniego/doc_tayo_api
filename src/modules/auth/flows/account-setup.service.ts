import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
import { assertPasswordPolicy } from '../password/password-policy.js';
import { UserTokenService } from './user-token.service.js';

/**
 * First password for a user created by tenant onboarding (status `pending`).
 * Consuming the emailed token proves control of the email address.
 */
@Injectable()
export class AccountSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly hasher: PasswordHasher,
    private readonly tokens: UserTokenService,
    private readonly audit: AuditService,
  ) {}

  async setup(
    token: string,
    newPassword: string,
    fullName?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await this.tokens.find(tx, token, 'account_setup');
      if (!found || found.user.status !== 'pending') {
        throw new DomainError('TOKEN_INVALID');
      }
      assertPasswordPolicy(newPassword, found.user.email);
      if (!(await this.tokens.consume(tx, found.id))) {
        throw new DomainError('TOKEN_INVALID');
      }

      const now = this.clock.now();
      await tx.user.update({
        where: { id: found.user.id },
        data: {
          status: 'active',
          passwordHash: await this.hasher.hash(newPassword),
          passwordChangedAt: now,
          emailVerifiedAt: now,
          failedLoginCount: 0,
          lockedUntil: null,
          ...(fullName ? { fullName } : {}),
        },
      });
      await this.audit.record(tx, {
        action: 'auth.account_setup',
        entityType: 'user',
        entityId: found.user.id,
        tenantId: null,
        actorUserId: found.user.id,
        actorMembershipId: null,
      });
    });
  }
}
