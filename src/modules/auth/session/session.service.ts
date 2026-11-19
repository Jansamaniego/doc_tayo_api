import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Clock } from '../../../common/security/clock.js';
import { generateToken, hashToken } from '../../../common/security/token.js';
import { authConfig } from '../../../config/configuration.js';
import type {
  PrismaClient,
  SessionRevokedReason,
} from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';

/** The session/refresh-token delegates; satisfied by PrismaService or a transaction. */
export type SessionDb = Pick<PrismaClient, 'session' | 'refreshToken'>;

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreatedSession {
  sessionId: string;
  refreshToken: string;
  absoluteExpiresAt: Date;
}

export interface ActiveSession {
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
}

const USER_AGENT_MAX = 256;
/** `last_used_at` / `idle_expires_at` are bumped at most this often per session. */
const TOUCH_INTERVAL_MS = 60_000;

/** Creation, lookup and revocation of sessions (one session = one refresh-token family). */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  async create(
    userId: string,
    options: SessionMeta & { activeTenantId?: string | null } = {},
    db: SessionDb = this.prisma,
  ): Promise<CreatedSession> {
    const now = this.clock.now();
    const { idleTtlSeconds, absoluteTtlSeconds } = this.config.session;
    const absoluteExpiresAt = new Date(
      now.getTime() + absoluteTtlSeconds * 1000,
    );
    const idleExpiresAt = new Date(now.getTime() + idleTtlSeconds * 1000);
    const refreshToken = generateToken();

    const session = await db.session.create({
      data: {
        userId,
        activeTenantId: options.activeTenantId ?? null,
        principalType: 'staff',
        userAgent: options.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
        ip: options.ip ?? null,
        lastUsedAt: now,
        idleExpiresAt,
        absoluteExpiresAt,
      },
      select: { id: true },
    });
    await db.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: hashToken(refreshToken),
        expiresAt: absoluteExpiresAt,
      },
    });
    return { sessionId: session.id, refreshToken, absoluteExpiresAt };
  }

  /**
   * The session if it is still usable for this user, else null. One query
   * (session joined to its user). Also slides the idle window, at most once a
   * minute, never past the absolute lifetime.
   */
  async findActive(
    sessionId: string,
    userId: string,
  ): Promise<ActiveSession | null> {
    const now = this.clock.now();
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        idleExpiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
        user: { status: 'active' },
      },
      select: {
        id: true,
        userId: true,
        activeTenantId: true,
        lastUsedAt: true,
      },
    });
    if (!session) return null;

    if (now.getTime() - session.lastUsedAt.getTime() >= TOUCH_INTERVAL_MS) {
      const idle = new Date(
        now.getTime() + this.config.session.idleTtlSeconds * 1000,
      );
      // Conditional: concurrent requests bump once. LEAST keeps idle <= absolute.
      await this.prisma.$executeRaw`
        UPDATE sessions
        SET last_used_at = ${now},
            idle_expires_at = LEAST(${idle}::timestamptz, absolute_expires_at),
            updated_at = ${now}
        WHERE id = ${session.id}::uuid
          AND last_used_at < ${new Date(now.getTime() - TOUCH_INTERVAL_MS)}::timestamptz`;
    }
    return {
      sessionId: session.id,
      userId: session.userId,
      activeTenantId: session.activeTenantId,
    };
  }

  /** Revokes one session. False when it was already revoked (first reason is kept). */
  async revoke(
    sessionId: string,
    reason: SessionRevokedReason,
    db: SessionDb = this.prisma,
  ): Promise<boolean> {
    const { count } = await db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return count > 0;
  }

  /** Revokes every live session of a user, optionally sparing one. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevokedReason,
    options: { exceptSessionId?: string } = {},
    db: SessionDb = this.prisma,
  ): Promise<number> {
    const { count } = await db.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(options.exceptSessionId
          ? { id: { not: options.exceptSessionId } }
          : {}),
      },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return count;
  }
}
