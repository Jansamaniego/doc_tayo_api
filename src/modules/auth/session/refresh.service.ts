import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { generateToken, hashToken } from '../../../common/security/token.js';
import { authConfig } from '../../../config/configuration.js';
import type { UserStatus } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { AccessTokenService } from './access-token.service.js';
import type { SessionMeta } from './session.service.js';

export interface RotatedSession {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  userId: string;
  sessionId: string;
  activeTenantId: string | null;
  absoluteExpiresAt: Date;
}

interface TokenRow {
  token_id: string;
  rotated_at: Date | null;
  token_expires_at: Date;
  session_id: string;
  user_id: string;
  active_tenant_id: string | null;
  revoked_at: Date | null;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  user_status: UserStatus;
}

type Outcome =
  | {
      kind: 'rotated';
      session: Omit<RotatedSession, 'accessToken' | 'expiresIn'>;
    }
  | { kind: 'reuse' }
  | { kind: 'invalid' };

/**
 * Refresh-token rotation with reuse detection (plans/02-authentication.md §6.2).
 * One session is one token family: presenting any token that was already
 * rotated revokes the whole session. There is no grace window (D10), so two
 * concurrent refreshes with one token make the second one a reuse.
 */
@Injectable()
export class RefreshService {
  private readonly logger = new Logger(RefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly accessTokens: AccessTokenService,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  /**
   * `_meta` is accepted but not used: the session's user agent and IP are
   * recorded at login only (plans/02-authentication.md §19, deviation 13).
   */
  async rotate(
    presentedToken: string,
    _meta: SessionMeta = {},
  ): Promise<RotatedSession> {
    if (!presentedToken) throw new DomainError('UNAUTHENTICATED');
    const tokenHash = hashToken(presentedToken);
    const now = this.clock.now();

    // The transaction COMMITS the reuse revocation before we throw, otherwise
    // the throw would roll the revocation back.
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<Outcome> => {
        const rows = await tx.$queryRaw<TokenRow[]>`
          SELECT rt.id AS token_id, rt.rotated_at, rt.expires_at AS token_expires_at,
                 s.id AS session_id, s.user_id, s.active_tenant_id, s.revoked_at,
                 s.idle_expires_at, s.absolute_expires_at, u.status::text AS user_status
          FROM refresh_tokens rt
          JOIN sessions s ON s.id = rt.session_id
          JOIN users u ON u.id = s.user_id
          WHERE rt.token_hash = ${tokenHash}
          FOR UPDATE OF rt`;
        const row = rows[0];
        if (!row) return { kind: 'invalid' };

        if (row.rotated_at) {
          if (!row.revoked_at) {
            await tx.session.updateMany({
              where: { id: row.session_id, revokedAt: null },
              data: { revokedAt: now, revokedReason: 'refresh_reuse' },
            });
            await this.audit.record(tx, {
              action: 'auth.refresh_reuse_detected',
              entityType: 'session',
              entityId: row.session_id,
              tenantId: null,
              actorUserId: row.user_id,
              actorMembershipId: null,
            });
          }
          return { kind: 'reuse' };
        }

        if (
          row.revoked_at ||
          row.user_status !== 'active' ||
          row.token_expires_at <= now ||
          row.idle_expires_at <= now ||
          row.absolute_expires_at <= now
        ) {
          return { kind: 'invalid' };
        }

        const refreshToken = generateToken();
        await tx.refreshToken.update({
          where: { id: row.token_id },
          data: { rotatedAt: now },
        });
        await tx.refreshToken.create({
          data: {
            sessionId: row.session_id,
            tokenHash: hashToken(refreshToken),
            expiresAt: row.absolute_expires_at,
          },
        });
        const idle = new Date(
          now.getTime() + this.config.session.idleTtlSeconds * 1000,
        );
        await tx.session.update({
          where: { id: row.session_id },
          data: {
            lastUsedAt: now,
            idleExpiresAt:
              idle < row.absolute_expires_at ? idle : row.absolute_expires_at,
          },
        });
        return {
          kind: 'rotated',
          session: {
            refreshToken,
            userId: row.user_id,
            sessionId: row.session_id,
            activeTenantId: row.active_tenant_id,
            absoluteExpiresAt: row.absolute_expires_at,
          },
        };
      },
    );

    if (outcome.kind === 'reuse') {
      // Security event: ids only, never a token.
      this.logger.warn({ message: 'refresh token reuse detected' });
      throw new DomainError('UNAUTHENTICATED');
    }
    if (outcome.kind === 'invalid') throw new DomainError('UNAUTHENTICATED');

    const { token, expiresIn } = await this.accessTokens.sign(
      outcome.session.userId,
      outcome.session.sessionId,
    );
    return { ...outcome.session, accessToken: token, expiresIn };
  }
}
