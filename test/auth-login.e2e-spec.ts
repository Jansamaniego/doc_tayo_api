import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { LoginService } from '../src/modules/auth/flows/login.service.js';
import { PasswordHasher } from '../src/modules/auth/password/password-hasher.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  refreshCookie,
  seedMembership,
  setCookies,
  TEST_PASSWORD,
  type TestUser,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { MINUTE, TestClock } from './support/test-clock.js';
import { ThrottlerStorage } from '@nestjs/throttler';

const LOGIN = '/api/v1/auth/login';

describe('login, throttling and lockout (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let clock: TestClock;
  let throttle: ResettableThrottlerStorage;
  let user: TestUser;

  beforeAll(async () => {
    owner = createOwnerClient();
    clock = new TestClock();
    app = await createTestApp({ productionAuthenticator: true, clock });
    throttle = app.get(ThrottlerStorage) as ResettableThrottlerStorage;
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    throttle.reset();
    await resetTenancyData(owner);
    user = await createActiveUser(owner, 'doc@example.com');
  });

  const login = (email: string, password: string) =>
    request(app.getHttpServer()).post(LOGIN).send({ email, password });
  const sessionCount = () => owner.session.count();
  const stored = () =>
    owner.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        failedLoginCount: true,
        lockedUntil: true,
        passwordHash: true,
      },
    });

  describe('success', () => {
    it('returns an access token, the user and memberships; the refresh token only in an httpOnly cookie', async () => {
      const res = await login(user.email, user.password).expect(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(res.body.data).toMatchObject({
        expiresIn: 900,
        user: { id: user.id, email: user.email, fullName: user.email },
        memberships: [],
        activeTenantId: null,
      });
      expect(typeof res.body.data.accessToken).toBe('string');
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('refreshToken');
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('argon2');
      expect(refreshCookie(res)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await sessionCount()).toBe(1);
    });

    it('normalises the email (case and surrounding spaces)', async () => {
      await login('  DOC@Example.COM ', user.password).expect(200);
    });

    it('records the user agent and IP on the session and audits auth.login', async () => {
      await request(app.getHttpServer())
        .post(LOGIN)
        .set('User-Agent', 'JestBrowser/1.0')
        .send({ email: user.email, password: user.password })
        .expect(200);
      const session = await owner.session.findFirstOrThrow();
      expect(session.userAgent).toBe('JestBrowser/1.0');
      expect(session.ip).toBeTruthy();
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.login' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: null,
        entityType: 'user',
        entityId: user.id,
        actorUserId: user.id,
      });
    });

    it('works with the issued access token on an authenticated route', async () => {
      const res = await login(user.email, user.password).expect(200);
      await request(app.getHttpServer())
        .get('/api/v1/_tenant/no-tenant')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
    });
  });

  describe('memberships and the initial active tenant', () => {
    it('exactly one active membership in an active tenant becomes the active tenant', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const res = await login(user.email, user.password).expect(200);
      expect(res.body.data.activeTenantId).toBe(a.tenantId);
      expect(res.body.data.memberships).toEqual([
        {
          tenantId: a.tenantId,
          tenantName: 'clinic-a',
          tenantStatus: 'active',
          membershipStatus: 'active',
          roles: ['Owner'],
        },
      ]);
    });

    it('several memberships: no automatic choice', async () => {
      await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      await seedMembership(owner, user.id, 'clinic-b', ['receptionist']);
      const res = await login(user.email, user.password).expect(200);
      expect(res.body.data.activeTenantId).toBeNull();
      expect(res.body.data.memberships).toHaveLength(2);
    });

    it('a suspended tenant is listed but not chosen; a removed membership is not listed', async () => {
      await seedMembership(owner, user.id, 'clinic-a', ['owner'], {
        tenantStatus: 'suspended',
      });
      await seedMembership(owner, user.id, 'clinic-b', ['owner'], {
        membershipStatus: 'removed',
      });
      const res = await login(user.email, user.password).expect(200);
      expect(res.body.data.activeTenantId).toBeNull();
      expect(res.body.data.memberships).toHaveLength(1);
      expect(res.body.data.memberships[0]).toMatchObject({
        tenantName: 'clinic-a',
        tenantStatus: 'suspended',
      });
    });
  });

  describe('failure is generic', () => {
    const wrong = async () => {
      await createActiveUser(owner, 'pending@example.com', {
        status: 'pending',
      });
      await createActiveUser(owner, 'gone@example.com', {
        status: 'deactivated',
      });
      return [
        login(user.email, 'wrong password here'),
        login('nobody@example.com', TEST_PASSWORD),
        login('pending@example.com', TEST_PASSWORD),
        login('gone@example.com', TEST_PASSWORD),
      ];
    };

    it('wrong password, unknown email, pending and deactivated users get identical 401 bodies', async () => {
      const responses = await Promise.all(await wrong());
      for (const res of responses) expect(res.status).toBe(401);
      const bodies = responses.map((r) => {
        const { requestId: _ignored, ...rest } = r.body.error;
        return rest;
      });
      for (const body of bodies) {
        expect(body).toEqual({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: 'The email or password is incorrect.',
        });
      }
      expect(await sessionCount()).toBe(0);
      expect(responses.flatMap(setCookies)).toEqual([]);
    });

    it('audits a failed login only for an existing user', async () => {
      await login(user.email, 'wrong password here').expect(401);
      await login('nobody@example.com', 'wrong password here').expect(401);
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.login_failed' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tenantId: null,
        entityType: 'user',
        entityId: user.id,
      });
    });

    it('rejects unknown fields and bad input with VALIDATION_FAILED', async () => {
      const unknown = await request(app.getHttpServer())
        .post(LOGIN)
        .send({ email: user.email, password: user.password, status: 'active' })
        .expect(400);
      expect(unknown.body.error.code).toBe('VALIDATION_FAILED');
      for (const body of [
        {},
        { email: 'not-an-email', password: 'x' },
        { email: user.email },
      ]) {
        const res = await request(app.getHttpServer())
          .post(LOGIN)
          .send(body)
          .expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });
  });

  describe('throttling (real limits)', () => {
    it('the 6th attempt for one IP + email within 15 minutes is 429 with Retry-After', async () => {
      for (let i = 0; i < 5; i++) {
        await login(user.email, 'wrong password here').expect(401);
      }
      const res = await login(user.email, user.password).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('answers identically for an unknown email (no account enumeration)', async () => {
      for (let i = 0; i < 5; i++) {
        await login('nobody@example.com', 'wrong password here').expect(401);
      }
      const res = await login(
        'nobody@example.com',
        'wrong password here',
      ).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('one email being throttled does not block another email from the same IP', async () => {
      for (let i = 0; i < 6; i++)
        await login(user.email, 'wrong password here');
      await login('other-nobody@example.com', 'x').expect(401);
    });

    it('30 attempts from one IP in 15 minutes trip the per-IP limit', async () => {
      for (let i = 0; i < 30; i++) {
        await login(`user${i}@example.com`, 'wrong password here').expect(401);
      }
      const res = await login(
        'user31@example.com',
        'wrong password here',
      ).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });

    it('health stays reachable (not throttled)', async () => {
      for (let i = 0; i < 40; i++) {
        await request(app.getHttpServer()).get('/api/health').expect(200);
      }
    });
  });

  describe('account lockout', () => {
    it('locks after 10 consecutive failures; the counter is per account', async () => {
      const service = app.get(LoginService);
      const attempt = () =>
        service
          .login(user.email, 'wrong password here', {})
          .catch((e: unknown) => e);
      for (let i = 0; i < 9; i++) {
        expect(await attempt()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      }
      expect((await stored()).lockedUntil).toBeNull();
      expect(await attempt()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
      const locked = await stored();
      expect(locked.failedLoginCount).toBe(10);
      expect(locked.lockedUntil!.getTime()).toBe(
        clock.now().getTime() + 15 * MINUTE,
      );
    });

    it('while locked, even the correct password gets the same 429 as a throttle', async () => {
      await owner.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 10,
          lockedUntil: new Date(clock.now().getTime() + 10 * MINUTE),
        },
      });
      const res = await login(user.email, user.password).expect(429);
      expect(res.body.error).toMatchObject({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Please wait a moment and try again.',
      });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(await sessionCount()).toBe(0);
    });

    it('after the lock expires a correct login succeeds and resets the counter', async () => {
      await owner.user.update({
        where: { id: user.id },
        data: {
          failedLoginCount: 10,
          lockedUntil: new Date(clock.now().getTime() + 15 * MINUTE),
        },
      });
      clock.advance(15 * MINUTE + 1000);
      await login(user.email, user.password).expect(200);
      expect(await stored()).toMatchObject({
        failedLoginCount: 0,
        lockedUntil: null,
      });
    });

    it('a success before the limit resets the failure counter', async () => {
      await login(user.email, 'wrong password here').expect(401);
      await login(user.email, 'wrong password here').expect(401);
      expect((await stored()).failedLoginCount).toBe(2);
      await login(user.email, user.password).expect(200);
      expect((await stored()).failedLoginCount).toBe(0);
    });

    it('unknown emails never create state', async () => {
      await login('nobody@example.com', 'wrong password here').expect(401);
      expect(await owner.user.count()).toBe(1);
    });
  });

  describe('rehash', () => {
    it('upgrades a hash made with older Argon2 parameters on successful login', async () => {
      const weak = new PasswordHasher({
        memoryKib: 512,
        timeCost: 1,
        parallelism: 1,
      });
      const weakHash = await weak.hash(user.password);
      await owner.user.update({
        where: { id: user.id },
        data: { passwordHash: weakHash },
      });
      await login(user.email, user.password).expect(200);
      const after = (await stored()).passwordHash!;
      expect(after).not.toBe(weakHash);
      expect(after).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
      // and it still verifies
      await login(user.email, user.password).expect(200);
    });
  });
});
