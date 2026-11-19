import type { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DomainError } from '../src/common/errors/domain-error.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { AccessTokenService } from '../src/modules/auth/access-token.service.js';
import { RefreshService } from '../src/modules/auth/refresh.service.js';
import { SessionService } from '../src/modules/auth/session.service.js';
import { createTestApp } from './setup/create-test-app.js';
import { createActiveUser, type TestUser } from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { DAY, MINUTE, TestClock } from './support/test-clock.js';

const PROBE = '/api/v1/_tenant/no-tenant';
const b64url = (value: object | string) =>
  Buffer.from(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).toString('base64url');

describe('access tokens, sessions and refresh (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let clock: TestClock;
  let sessions: SessionService;
  let tokens: AccessTokenService;
  let refresh: RefreshService;
  let jwt: JwtService;
  let user: TestUser;

  beforeAll(async () => {
    owner = createOwnerClient();
    clock = new TestClock();
    app = await createTestApp({ productionAuthenticator: true, clock });
    sessions = app.get(SessionService);
    tokens = app.get(AccessTokenService);
    refresh = app.get(RefreshService);
    jwt = app.get(JwtService);
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    user = await createActiveUser(owner, 'doc@example.com');
  });

  const get = (token?: string) => {
    const req = request(app.getHttpServer()).get(PROBE);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const newSession = async (userId = user.id) => {
    const created = await sessions.create(userId, {});
    const { token } = await tokens.sign(userId, created.sessionId);
    return { ...created, accessToken: token };
  };
  const row = (id: string) =>
    owner.session.findUniqueOrThrow({ where: { id } });

  describe('access token', () => {
    it('carries exactly sub, sid, typ, iat, exp, iss, aud (no tenant, role or permission)', async () => {
      const { accessToken, sessionId } = await newSession();
      const payload = jwt.decode<Record<string, unknown>>(accessToken);
      expect(Object.keys(payload).sort()).toEqual(
        ['aud', 'exp', 'iat', 'iss', 'sid', 'sub', 'typ'].sort(),
      );
      expect(payload).toMatchObject({
        sub: user.id,
        sid: sessionId,
        typ: 'staff',
        iss: 'doctayo-api',
        aud: 'doctayo',
      });
      expect((payload.exp as number) - (payload.iat as number)).toBe(15 * 60);
      expect(jwt.decode(accessToken, { complete: true }).header.alg).toBe(
        'HS256',
      );
    });

    it('authenticates a valid token', async () => {
      const { accessToken } = await newSession();
      const res = await get(accessToken).expect(200);
      expect(res.body.data.userId).toBe(user.id);
    });

    it('rejects a missing header', async () => {
      const res = await get().expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it.each([
      ['a tampered signature', (t: string) => t.slice(0, -3) + 'AAA'],
      ['a malformed token', () => 'not.a.jwt'],
      ['an empty bearer', () => ''],
      [
        'alg none',
        (t: string) => {
          const [, payload] = t.split('.');
          return `${b64url({ alg: 'none', typ: 'JWT' })}.${payload}.`;
        },
      ],
    ])('rejects %s with UNAUTHENTICATED', async (_label, mutate) => {
      const { accessToken } = await newSession();
      const res = await get(mutate(accessToken)).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it.each([
      ['HS512', { algorithm: 'HS512' as const }],
      ['the wrong issuer', { issuer: 'someone-else' }],
      ['the wrong audience', { audience: 'other-app' }],
    ])('rejects a token signed with %s', async (_label, options) => {
      const { sessionId } = await newSession();
      const forged = await jwt.signAsync(
        { sid: sessionId, typ: 'staff' },
        {
          subject: user.id,
          expiresIn: 900,
          algorithm: 'HS256',
          issuer: 'doctayo-api',
          audience: 'doctayo',
          ...options,
        },
      );
      const res = await get(forged).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects a token signed with another secret', async () => {
      const { sessionId } = await newSession();
      const forged = await jwt.signAsync(
        { sid: sessionId, typ: 'staff' },
        {
          secret: 'a-completely-different-secret-of-32-bytes!!',
          subject: user.id,
          expiresIn: 900,
          issuer: 'doctayo-api',
          audience: 'doctayo',
        },
      );
      await get(forged).expect(401);
    });

    it('rejects a token with the wrong principal type', async () => {
      const { sessionId } = await newSession();
      const forged = await jwt.signAsync(
        { sid: sessionId, typ: 'patient' },
        {
          subject: user.id,
          expiresIn: 900,
          issuer: 'doctayo-api',
          audience: 'doctayo',
        },
      );
      await get(forged).expect(401);
    });

    it('answers ACCESS_TOKEN_EXPIRED once the token has expired (so the client refreshes)', async () => {
      const { accessToken } = await newSession();
      clock.advance(16 * MINUTE); // past 15 min + 30 s tolerance
      const res = await get(accessToken).expect(401);
      expect(res.body.error.code).toBe('ACCESS_TOKEN_EXPIRED');
    });

    it('allows 30 seconds of clock tolerance', async () => {
      const { accessToken } = await newSession();
      clock.advance(15 * MINUTE + 20_000);
      await get(accessToken).expect(200);
    });

    it('never accepts the token from the query string', async () => {
      const { accessToken } = await newSession();
      await request(app.getHttpServer())
        .get(`${PROBE}?access_token=${accessToken}&token=${accessToken}`)
        .expect(401);
    });
  });

  describe('session re-verification on every request', () => {
    it('a revoked session stops working immediately', async () => {
      const { accessToken, sessionId } = await newSession();
      await get(accessToken).expect(200);
      await sessions.revoke(sessionId, 'logout');
      const res = await get(accessToken).expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
      const stored = await row(sessionId);
      expect(stored.revokedReason).toBe('logout');
      expect(stored.revokedAt).not.toBeNull();
    });

    it('a deactivated user stops working immediately', async () => {
      const { accessToken } = await newSession();
      await owner.user.update({
        where: { id: user.id },
        data: { status: 'deactivated' },
      });
      await get(accessToken).expect(401);
    });

    it('a pending user cannot use a session', async () => {
      const { accessToken } = await newSession();
      await owner.user.update({
        where: { id: user.id },
        data: { status: 'pending' },
      });
      await get(accessToken).expect(401);
    });

    it('a token whose sub does not match the session owner is refused', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      const { sessionId } = await newSession(other.id);
      const { token } = await tokens.sign(user.id, sessionId);
      await get(token).expect(401);
    });

    it('idle expiry: a new token for a long-idle session is refused', async () => {
      const { sessionId } = await newSession();
      clock.advance(15 * DAY);
      const { token } = await tokens.sign(user.id, sessionId);
      await get(token).expect(401);
    });

    it('absolute expiry holds even when the session was used all along', async () => {
      const { sessionId } = await newSession();
      for (let day = 0; day < 31; day++) {
        clock.advance(DAY);
        const { token } = await tokens.sign(user.id, sessionId);
        if (day < 29) await get(token).expect(200);
      }
      const { token } = await tokens.sign(user.id, sessionId);
      await get(token).expect(401);
    });

    it('bumps last_used_at / idle_expires_at at most once per minute', async () => {
      const { accessToken, sessionId } = await newSession();
      const first = await row(sessionId);
      clock.advance(30_000);
      await get(accessToken).expect(200);
      const within = await row(sessionId);
      expect(within.lastUsedAt.getTime()).toBe(first.lastUsedAt.getTime());

      clock.advance(2 * MINUTE);
      const { token } = await tokens.sign(user.id, sessionId);
      await get(token).expect(200);
      const after = await row(sessionId);
      expect(after.lastUsedAt.getTime()).toBeGreaterThan(
        first.lastUsedAt.getTime(),
      );
      expect(after.idleExpiresAt.getTime()).toBeGreaterThan(
        first.idleExpiresAt.getTime(),
      );
      expect(after.idleExpiresAt.getTime()).toBeLessThanOrEqual(
        after.absoluteExpiresAt.getTime(),
      );
    });
  });

  describe('session service', () => {
    it('stores only a SHA-256 hash of the refresh token', async () => {
      const { refreshToken, sessionId } = await newSession();
      const rows = await owner.refreshToken.findMany({ where: { sessionId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.tokenHash).not.toBe(refreshToken);
      expect(refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('sets lifetimes from configuration (14 d idle, 30 d absolute)', async () => {
      const { sessionId } = await newSession();
      const stored = await row(sessionId);
      const created = stored.lastUsedAt.getTime();
      expect(stored.idleExpiresAt.getTime() - created).toBe(14 * DAY);
      expect(stored.absoluteExpiresAt.getTime() - created).toBe(30 * DAY);
    });

    it('truncates the user agent to 256 characters and stores the IP', async () => {
      const created = await sessions.create(user.id, {
        userAgent: 'x'.repeat(400),
        ip: '203.0.113.9',
      });
      const stored = await row(created.sessionId);
      expect(stored.userAgent).toHaveLength(256);
      expect(stored.ip).toBe('203.0.113.9');
    });

    it('revokeAllForUser revokes only that user, optionally sparing one session', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      const a = await newSession();
      const b = await newSession();
      const o = await newSession(other.id);
      const count = await sessions.revokeAllForUser(user.id, 'logout_all', {
        exceptSessionId: b.sessionId,
      });
      expect(count).toBe(1);
      expect((await row(a.sessionId)).revokedReason).toBe('logout_all');
      expect((await row(b.sessionId)).revokedAt).toBeNull();
      expect((await row(o.sessionId)).revokedAt).toBeNull();
      await get(a.accessToken).expect(401);
      await get(b.accessToken).expect(200);
      await get(o.accessToken).expect(200);
    });

    it('revoking twice keeps the first reason', async () => {
      const { sessionId } = await newSession();
      expect(await sessions.revoke(sessionId, 'logout')).toBe(true);
      expect(await sessions.revoke(sessionId, 'admin')).toBe(false);
      expect((await row(sessionId)).revokedReason).toBe('logout');
    });
  });

  describe('refresh rotation', () => {
    it('rotates: returns a new pair and the old refresh token no longer works', async () => {
      const first = await newSession();
      const next = await refresh.rotate(first.refreshToken, {});
      expect(next.refreshToken).not.toBe(first.refreshToken);
      expect(next.sessionId).toBe(first.sessionId);
      expect(next.userId).toBe(user.id);
      await get(next.accessToken).expect(200);

      const rows = await owner.refreshToken.findMany({
        where: { sessionId: first.sessionId },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      expect(rows[0]!.rotatedAt).not.toBeNull();
      expect(rows[1]!.rotatedAt).toBeNull();
    });

    it('reuse of an old token revokes the whole session and audits it', async () => {
      const first = await newSession();
      const second = await refresh.rotate(first.refreshToken, {});
      await expect(
        refresh.rotate(first.refreshToken, {}),
      ).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      // The attacker's AND the legitimate client's tokens are dead.
      await get(second.accessToken).expect(401);
      await expect(
        refresh.rotate(second.refreshToken, {}),
      ).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      const stored = await row(first.sessionId);
      expect(stored.revokedReason).toBe('refresh_reuse');

      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.refresh_reuse_detected' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'session',
        entityId: first.sessionId,
        tenantId: null,
        actorUserId: user.id,
      });
    });

    it('two concurrent refreshes with one token: one wins, the other is reuse (no grace window)', async () => {
      const first = await newSession();
      const results = await Promise.allSettled([
        refresh.rotate(first.refreshToken, {}),
        refresh.rotate(first.refreshToken, {}),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        DomainError,
      );
      expect((await row(first.sessionId)).revokedReason).toBe('refresh_reuse');
    });

    it.each([
      ['an unknown token', () => 'A'.repeat(43)],
      ['an empty token', () => ''],
    ])('rejects %s', async (_label, token) => {
      await expect(refresh.rotate(token(), {})).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });

    it('rejects a revoked session, a deactivated user and an expired session', async () => {
      const revoked = await newSession();
      await sessions.revoke(revoked.sessionId, 'logout');
      await expect(
        refresh.rotate(revoked.refreshToken, {}),
      ).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });

      const deactivated = await newSession();
      await owner.user.update({
        where: { id: user.id },
        data: { status: 'deactivated' },
      });
      await expect(
        refresh.rotate(deactivated.refreshToken, {}),
      ).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      await owner.user.update({
        where: { id: user.id },
        data: { status: 'active' },
      });

      const idle = await newSession();
      clock.advance(15 * DAY);
      await expect(refresh.rotate(idle.refreshToken, {})).rejects.toMatchObject(
        {
          code: 'UNAUTHENTICATED',
        },
      );
    });

    it('extends the idle window but never past the absolute lifetime', async () => {
      const first = await newSession();
      let token = first.refreshToken;
      for (let i = 0; i < 3; i++) {
        clock.advance(9 * DAY); // day 9, 18, 27
        token = (await refresh.rotate(token, {})).refreshToken;
      }
      const stored = await row(first.sessionId);
      // Day 27 + 14 d idle would be day 41, but the session ends at day 30.
      expect(stored.idleExpiresAt.getTime()).toBe(
        stored.absoluteExpiresAt.getTime(),
      );
      clock.advance(4 * DAY); // day 31 > 30 day absolute
      await expect(refresh.rotate(token, {})).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    });

    it('keeps the session active tenant across rotation', async () => {
      const first = await newSession();
      const tenant = await owner.tenant.create({
        data: { name: 'T', slug: 't' },
      });
      await owner.session.update({
        where: { id: first.sessionId },
        data: { activeTenantId: tenant.id },
      });
      const next = await refresh.rotate(first.refreshToken, {});
      expect(next.activeTenantId).toBe(tenant.id);
    });
  });
});
