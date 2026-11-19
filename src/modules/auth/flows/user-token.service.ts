import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { generateToken, hashToken } from '../../../common/security/token.js';
import type {
  PrismaClient,
  UserStatus,
  UserTokenType,
} from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { assertPasswordPolicy } from '../password/password-policy.js';

export type UserTokenDb = Pick<PrismaClient, 'userToken'>;

/** How long each kind of emailed link stays valid. */
const TTL_MS: Record<UserTokenType, number> = {
  password_reset: 30 * 60 * 1000,
  account_setup: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Emailed single-use tokens (password reset, account setup). Only a SHA-256
 * hash is stored. Issuing a new token invalidates the user's earlier unused
 * tokens of the same type, so only the newest link works.
 */
@Injectable()
export class UserTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** Returns the raw token to email. It is never stored or logged. */
  async issue(
    db: UserTokenDb,
    { userId, type }: { userId: string; type: UserTokenType },
  ): Promise<string> {
    const now = this.clock.now();
    await db.userToken.updateMany({
      where: { userId, type, usedAt: null },
      data: { usedAt: now },
    });
    const token = generateToken();
    await db.userToken.create({
      data: {
        userId,
        type,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + TTL_MS[type]),
      },
    });
    return token;
  }

  /**
   * Redeems a token for a user who must be in `userStatus`: finds it, checks
   * the new password policy, then consumes it. The policy runs BEFORE the
   * token is consumed, so a weak password does not burn the link. Throws
   * TOKEN_INVALID for an unknown, used, expired or wrong-status token.
   */
  async redeem(
    db: UserTokenDb,
    {
      token,
      type,
      userStatus,
      newPassword,
    }: {
      token: string;
      type: UserTokenType;
      userStatus: UserStatus;
      newPassword: string;
    },
  ) {
    const found = await this.find(db, { token, type });
    if (!found || found.user.status !== userStatus) {
      throw new DomainError('TOKEN_INVALID');
    }
    assertPasswordPolicy(newPassword, found.user.email);
    if (!(await this.consume(db, found.id))) {
      throw new DomainError('TOKEN_INVALID');
    }
    return found.user;
  }

  /** An unused, unexpired token of this type, with its user; otherwise null. */
  private find(
    db: UserTokenDb,
    { token, type }: { token: string; type: UserTokenType },
  ) {
    return db.userToken.findFirst({
      where: {
        tokenHash: hashToken(token),
        type,
        usedAt: null,
        expiresAt: { gt: this.clock.now() },
      },
      select: {
        id: true,
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            status: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
  }

  /** Atomically marks the token used. False when someone else just used it. */
  private async consume(db: UserTokenDb, tokenId: string): Promise<boolean> {
    const { count } = await db.userToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: this.clock.now() },
    });
    return count === 1;
  }
}
