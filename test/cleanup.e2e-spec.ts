import { SchedulerRegistry } from '@nestjs/schedule';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { generateToken, hashToken } from '../src/common/security/token.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { CleanupService } from '../src/modules/maintenance/cleanup.service.js';
import { createTestApp } from './setup/create-test-app.js';
import { createActiveUser, seedMembership } from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { DAY, TestClock } from './support/test-clock.js';

describe('daily cleanup of tokens, sessions and outbox rows (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let clock: TestClock;
  let cleanup: CleanupService;
  let userId: string;

  beforeAll(async () => {
    owner = createOwnerClient();
    clock = new TestClock();
    app = await createTestApp({ clock });
    cleanup = app.get(CleanupService);
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    userId = (await createActiveUser(owner, 'doc@example.com')).id;
  });

  const ago = (ms: number) => new Date(clock.now().getTime() - ms);
  const ahead = (ms: number) => new Date(clock.now().getTime() + ms);

  const userToken = (label: string, data: { expiresAt: Date; usedAt?: Date }) =>
    owner.userToken.create({
      data: {
        userId,
        type: 'password_reset',
        tokenHash: hashToken(label + generateToken()),
        ...data,
      },
      select: { id: true },
    });
  const session = async (data: {
    revokedAt?: Date;
    idleExpiresAt?: Date;
    absoluteExpiresAt?: Date;
  }) => {
    const created = await owner.session.create({
      data: {
        userId,
        lastUsedAt: ago(40 * DAY),
        idleExpiresAt: data.idleExpiresAt ?? ahead(10 * DAY),
        absoluteExpiresAt: data.absoluteExpiresAt ?? ahead(20 * DAY),
        ...(data.revokedAt
          ? { revokedAt: data.revokedAt, revokedReason: 'logout' as const }
          : {}),
      },
      select: { id: true },
    });
    await owner.refreshToken.create({
      data: {
        sessionId: created.id,
        tokenHash: hashToken(generateToken()),
        expiresAt: ahead(DAY),
      },
    });
    return created.id;
  };
  const ids = async (table: 'userToken' | 'session') =>
    (
      await (
        owner[table] as unknown as {
          findMany: (a: object) => Promise<{ id: string }[]>;
        }
      ).findMany({ select: { id: true } })
    )
      .map((r) => r.id)
      .sort();

  it('deletes user tokens that expired or were used more than 7 days ago, keeps the rest', async () => {
    const live = await userToken('live', { expiresAt: ahead(DAY) });
    const usedRecently = await userToken('used-recent', {
      expiresAt: ahead(DAY),
      usedAt: ago(6 * DAY),
    });
    const expiredLongAgo = await userToken('expired', { expiresAt: ago(DAY) });
    const usedLongAgo = await userToken('used-old', {
      expiresAt: ahead(DAY),
      usedAt: ago(8 * DAY),
    });

    const result = await cleanup.run();

    expect(await ids('userToken')).toEqual([live.id, usedRecently.id].sort());
    expect(result.userTokens).toBe(2);
    expect([expiredLongAgo.id, usedLongAgo.id]).toHaveLength(2);
  });

  it('deletes sessions revoked or expired more than 30 days ago together with their refresh tokens', async () => {
    const active = await session({});
    const revokedRecently = await session({ revokedAt: ago(29 * DAY) });
    const revokedLongAgo = await session({ revokedAt: ago(31 * DAY) });
    const absoluteExpiredLongAgo = await session({
      absoluteExpiresAt: ago(31 * DAY),
      idleExpiresAt: ago(35 * DAY),
    });
    const idleExpiredLongAgo = await session({ idleExpiresAt: ago(31 * DAY) });
    const expiredRecently = await session({
      absoluteExpiresAt: ago(5 * DAY),
      idleExpiresAt: ago(6 * DAY),
    });

    const result = await cleanup.run();

    expect(await ids('session')).toEqual(
      [active, revokedRecently, expiredRecently].sort(),
    );
    const remainingTokens = await owner.refreshToken.findMany({
      select: { sessionId: true },
    });
    expect(remainingTokens.map((t) => t.sessionId).sort()).toEqual(
      [active, revokedRecently, expiredRecently].sort(),
    );
    expect(result.sessions).toBe(3);
    expect(result.refreshTokens).toBe(3);
    expect([
      revokedLongAgo,
      absoluteExpiredLongAgo,
      idleExpiredLongAgo,
    ]).toHaveLength(3);
  });

  it('keeps expired invitations (history) and never touches audit logs', async () => {
    const clinic = await seedMembership(owner, userId, 'clinic-a', ['owner']);
    await owner.invitation.create({
      data: {
        tenantId: clinic.tenantId,
        email: 'old@example.com',
        roleId: clinic.roleIds.doctor!,
        invitedByMembershipId: clinic.membershipId,
        tokenHash: hashToken('x'),
        expiresAt: ago(60 * DAY),
      },
    });
    await owner.auditLog.create({
      data: {
        action: 'auth.login',
        entityType: 'user',
        entityId: userId,
        occurredAt: ago(90 * DAY),
      },
    });
    await cleanup.run();
    expect(await owner.invitation.count()).toBe(1);
    expect(await owner.auditLog.count()).toBe(1);
  });

  it('purges dead letters older than 14 days and inbox records older than 30 days', async () => {
    const now = Date.now();
    const DAY_MS = 86_400_000;
    const dead = (id: string, failedAt: number) =>
      owner.$executeRawUnsafe(
        `INSERT INTO nest_outbox.dead_letters (id, seq, topic, payload, headers, created_at, attempts, history, reason, failed_at)
         VALUES ($1, 1, 'mail.password_reset', '{}', '{}', $2, 3, '[]', 'exhausted', $2)`,
        id,
        failedAt,
      );
    await dead('dead-old', now - 15 * DAY_MS);
    await dead('dead-new', now - 13 * DAY_MS);
    const inbox = (id: string, at: number) =>
      owner.$executeRawUnsafe(
        `INSERT INTO nest_outbox.inbox (consumer, message_id, processed_at) VALUES ('mail-password-reset', $1, $2)`,
        id,
        at,
      );
    await inbox('in-old', now - 31 * DAY_MS);
    await inbox('in-new', now - 29 * DAY_MS);

    const result = await cleanup.run();

    const left = await owner.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM nest_outbox.dead_letters`,
    );
    expect(left.map((r) => r.id)).toEqual(['dead-new']);
    const inboxLeft = await owner.$queryRawUnsafe<{ message_id: string }[]>(
      `SELECT message_id FROM nest_outbox.inbox`,
    );
    expect(inboxLeft.map((r) => r.message_id)).toEqual(['in-new']);
    expect(result.deadLetters).toBe(1);
    expect(result.inbox).toBe(1);
  });

  it('is idempotent: a second run deletes nothing and does not fail', async () => {
    await userToken('expired', { expiresAt: ago(DAY) });
    await session({ revokedAt: ago(31 * DAY) });
    await cleanup.run();
    expect(await cleanup.run()).toEqual({
      userTokens: 0,
      sessions: 0,
      refreshTokens: 0,
      deadLetters: 0,
      inbox: 0,
    });
  });

  it('runs daily at 03:00 Asia/Manila', () => {
    const job = app.get(SchedulerRegistry).getCronJob('auth-cleanup');
    expect(job.cronTime.source).toBe('0 3 * * *');
    expect(job.cronTime.timeZone).toBe('Asia/Manila');
  });
});
