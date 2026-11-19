import { Injectable } from '@nestjs/common';
import { Clock } from '../../../common/security/clock.js';
import { generateToken, hashToken } from '../../../common/security/token.js';
import type {
  PrismaClient,
  UserTokenType,
} from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

export type UserTokenDb = Pick<PrismaClient, 'userToken'>;

export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
export const ACCOUNT_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
    userId: string,
    type: UserTokenType,
    ttlMs: number,
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
        expiresAt: new Date(now.getTime() + ttlMs),
      },
    });
    return token;
  }

  /** An unused, unexpired token of this type, with its user; otherwise null. */
  find(db: UserTokenDb, token: string, type: UserTokenType) {
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
  async consume(db: UserTokenDb, tokenId: string): Promise<boolean> {
    const { count } = await db.userToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: this.clock.now() },
    });
    return count === 1;
  }
}
