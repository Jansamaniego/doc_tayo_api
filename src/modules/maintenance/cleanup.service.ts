import { Injectable, Logger } from '@nestjs/common';
import { OutboxDeadLetters, OutboxInbox } from '@nestjs/outbox';
import { Clock } from '../../common/security/clock.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Used or expired emailed tokens are kept this long after use (diagnosis), then deleted. */
const USED_TOKEN_RETENTION_DAYS = 7;
/** Revoked or expired sessions are kept this long, then deleted with their refresh tokens. */
const SESSION_RETENTION_DAYS = 30;
const DEAD_LETTER_RETENTION_DAYS = 14;
const INBOX_RETENTION = '30d';

export interface CleanupResult {
  userTokens: number;
  sessions: number;
  refreshTokens: number;
  deadLetters: number;
  inbox: number;
}

/**
 * Housekeeping (plans/02-authentication.md §8.5). Idempotent, so it is safe to
 * run on several instances without a lock. Expired invitations and audit logs
 * are NEVER deleted (history). Dead letters hold the full payload of emails
 * that could not be delivered (including emailed tokens), so they are purged
 * after 14 days.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly deadLetters: OutboxDeadLetters,
    private readonly inbox: OutboxInbox,
  ) {}

  async run(): Promise<CleanupResult> {
    const now = this.clock.now();
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const sessionCutoff = before(SESSION_RETENTION_DAYS);

    const userTokens = await this.prisma.userToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: now } },
          { usedAt: { lt: before(USED_TOKEN_RETENTION_DAYS) } },
        ],
      },
    });

    const { sessions, refreshTokens } = await this.prisma.$transaction(
      async (tx) => {
        const old = await tx.session.findMany({
          where: {
            OR: [
              { revokedAt: { lt: sessionCutoff } },
              { absoluteExpiresAt: { lt: sessionCutoff } },
              { idleExpiresAt: { lt: sessionCutoff } },
            ],
          },
          select: { id: true },
        });
        const sessionIds = old.map((s) => s.id);
        const tokens = await tx.refreshToken.deleteMany({
          where: { sessionId: { in: sessionIds } },
        });
        const removed = await tx.session.deleteMany({
          where: { id: { in: sessionIds } },
        });
        return { sessions: removed.count, refreshTokens: tokens.count };
      },
    );

    const deadLetters = await this.deadLetters.purge({
      failedBefore: new Date(Date.now() - DEAD_LETTER_RETENTION_DAYS * DAY_MS),
    });
    const inbox = await this.inbox.prune(INBOX_RETENTION);

    const result = {
      userTokens: userTokens.count,
      sessions,
      refreshTokens,
      deadLetters,
      inbox,
    };
    // Counts only: nothing here is personal data.
    this.logger.log({ message: 'cleanup finished', ...result });
    return result;
  }
}
