import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/security/clock.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
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

  async setup({
    token,
    newPassword,
    fullName,
  }: {
    token: string;
    newPassword: string;
    fullName?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.tokens.redeem(tx, {
        token,
        type: 'account_setup',
        userStatus: 'pending',
        newPassword,
      });

      const now = this.clock.now();
      await tx.user.update({
        where: { id: user.id },
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
      await this.audit.recordAccountEvent(tx, {
        action: 'auth.account_setup',
        userId: user.id,
      });
    });
  }
}
