import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  ALLOWED_ORIGIN,
  createActiveUser,
  refreshCookie,
  seedMembership,
  setCookies,
  type TestUser,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { DAY, TestClock } from './support/test-clock.js';

const API = '/api/v1';

describe('auth endpoints: refresh cookie, logout, switch-tenant (real PostgreSQL)', () => {
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

  const http = () => request(app.getHttpServer());
  const signIn = async (who: TestUser = user) => {
    const res = await http()
      .post(`${API}/auth/login`)
      .send({ email: who.email, password: who.password })
      .expect(200);
    return {
      accessToken: res.body.data.accessToken as string,
      cookie: refreshCookie(res)!,
      res,
    };
  };
  const refreshWith = (
    cookie?: string,
    origin: string | null = ALLOWED_ORIGIN,
  ) => {
    const req = http().post(`${API}/auth/refresh`);
    if (cookie !== undefined) req.set('Cookie', `dt_refresh=${cookie}`);
    if (origin) req.set('Origin', origin);
    return req;
  };

  describe('refresh cookie', () => {
    it('is HttpOnly, SameSite=Strict, scoped to /api/v1/auth, Secure, with the remaining absolute lifetime', async () => {
      const { res } = await signIn();
      const header = setCookies(res).find((c) => c.startsWith('dt_refresh='))!;
      expect(header).toMatch(/;\s*HttpOnly/i);
      expect(header).toMatch(/;\s*SameSite=Strict/i);
      expect(header).toMatch(/;\s*Path=\/api\/v1\/auth(;|$)/);
      expect(header).toMatch(/;\s*Secure/i); // NODE_ENV=test: Secure everywhere except development
      expect(header).toMatch(/;\s*Max-Age=2592000(;|$)/); // 30 days
    });

    it('is not Secure in development (plain-HTTP localhost)', async () => {
      const dev = await createTestApp({
        productionAuthenticator: true,
        env: { NODE_ENV: 'development' },
      });
      try {
        const res = await request(dev.getHttpServer())
          .post(`${API}/auth/login`)
          .send({ email: user.email, password: user.password })
          .expect(200);
        const header = setCookies(res).find((c) =>
          c.startsWith('dt_refresh='),
        )!;
        expect(header).not.toMatch(/;\s*Secure/i);
        expect(header).toMatch(/;\s*HttpOnly/i);
      } finally {
        await dev.close();
      }
    });

    it('Max-Age shrinks with the session (never beyond the absolute lifetime)', async () => {
      const { cookie } = await signIn();
      clock.advance(10 * DAY);
      const res = await refreshWith(cookie).expect(200);
      const header = setCookies(res).find((c) => c.startsWith('dt_refresh='))!;
      expect(header).toMatch(/Max-Age=1728000(;|$)/); // 20 days left
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates the cookie and returns a new working access token', async () => {
      const first = await signIn();
      const res = await refreshWith(first.cookie).expect(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(res.body.data).toMatchObject({ expiresIn: 900 });
      expect(JSON.stringify(res.body)).not.toContain('refreshToken');
      const next = refreshCookie(res)!;
      expect(next).toBeTruthy();
      expect(next).not.toBe(first.cookie);
      await http()
        .get(`${API}/_tenant/no-tenant`)
        .set('Authorization', `Bearer ${res.body.data.accessToken}`)
        .expect(200);
    });

    it('requires an allowed Origin (CSRF defence in depth): missing or foreign -> 403 FORBIDDEN', async () => {
      const { cookie } = await signIn();
      for (const origin of [
        null,
        'https://evil.example',
        'http://localhost:5174',
      ]) {
        const res = await refreshWith(cookie, origin).expect(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
      // The refused attempts did not consume the token.
      await refreshWith(cookie).expect(200);
    });

    it('no cookie, an unknown cookie or garbage -> 401 UNAUTHENTICATED', async () => {
      for (const cookie of [undefined, 'A'.repeat(43), 'garbage']) {
        const res = await refreshWith(cookie).expect(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
      }
    });

    it('reuse of an already-rotated cookie revokes the session and clears nothing useful for the thief', async () => {
      const first = await signIn();
      const second = refreshCookie(
        await refreshWith(first.cookie).expect(200),
      )!;
      await refreshWith(first.cookie).expect(401); // replay
      await refreshWith(second).expect(401); // the family is dead
      await http()
        .get(`${API}/_tenant/no-tenant`)
        .set('Authorization', `Bearer ${first.accessToken}`)
        .expect(401);
      const session = await owner.session.findFirstOrThrow();
      expect(session.revokedReason).toBe('refresh_reuse');
    });

    it('never takes the token from the body or query string', async () => {
      const { cookie } = await signIn();
      await http()
        .post(`${API}/auth/refresh?refreshToken=${cookie}`)
        .set('Origin', ALLOWED_ORIGIN)
        .send({ refreshToken: cookie })
        .expect(401);
    });

    it('is throttled (30 per minute per IP)', async () => {
      for (let i = 0; i < 30; i++)
        await refreshWith('A'.repeat(43)).expect(401);
      const res = await refreshWith('A'.repeat(43)).expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /auth/logout and /auth/logout-all', () => {
    it('logout revokes the current session, clears the cookie and kills both tokens', async () => {
      const { accessToken, cookie } = await signIn();
      const res = await http()
        .post(`${API}/auth/logout`)
        .set('Authorization', `Bearer ${accessToken}`)
        .set('Origin', ALLOWED_ORIGIN)
        .expect(204);
      expect(res.text).toBe('');
      const cleared = setCookies(res).find((c) => c.startsWith('dt_refresh='))!;
      expect(cleared).toMatch(/^dt_refresh=;/);
      expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
      expect(cleared).toMatch(/(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
      await http()
        .get(`${API}/_tenant/no-tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(401);
      await refreshWith(cookie).expect(401);
      expect((await owner.session.findFirstOrThrow()).revokedReason).toBe(
        'logout',
      );
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.logout' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entityType: 'session', tenantId: null });
    });

    it('logout needs authentication and an allowed Origin', async () => {
      const { accessToken } = await signIn();
      await http()
        .post(`${API}/auth/logout`)
        .set('Origin', ALLOWED_ORIGIN)
        .expect(401);
      const res = await http()
        .post(`${API}/auth/logout`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      // still signed in
      await http()
        .get(`${API}/_tenant/no-tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
    });

    it('logout-all revokes every session of the user and nobody else’s', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      const a = await signIn();
      const b = await signIn();
      const o = await signIn(other);
      await http()
        .post(`${API}/auth/logout-all`)
        .set('Authorization', `Bearer ${a.accessToken}`)
        .set('Origin', ALLOWED_ORIGIN)
        .expect(204);
      for (const t of [a, b]) {
        await http()
          .get(`${API}/_tenant/no-tenant`)
          .set('Authorization', `Bearer ${t.accessToken}`)
          .expect(401);
        await refreshWith(t.cookie).expect(401);
      }
      await http()
        .get(`${API}/_tenant/no-tenant`)
        .set('Authorization', `Bearer ${o.accessToken}`)
        .expect(200);
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.logout_all' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ entityType: 'user', entityId: user.id });
    });
  });

  describe('POST /auth/switch-tenant', () => {
    const switchTo = (accessToken: string, tenantId: unknown) =>
      http()
        .post(`${API}/auth/switch-tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ tenantId });

    it('applies on the very next request, with the new tenant’s permissions only', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const b = await seedMembership(owner, user.id, 'clinic-b', [
        'receptionist',
      ]);
      await owner.branch.create({
        data: { tenantId: a.tenantId, name: 'A-main' },
      });
      await owner.branch.create({
        data: { tenantId: b.tenantId, name: 'B-main' },
      });
      const { accessToken } = await signIn(); // two memberships: no active tenant yet
      await http()
        .get(`${API}/branches`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      const toA = await switchTo(accessToken, a.tenantId).expect(200);
      expect(toA.body.data).toMatchObject({
        activeTenantId: a.tenantId,
        tenant: { id: a.tenantId, name: 'clinic-a', status: 'active' },
      });
      expect(toA.body.data.permissions).toContain('branches.manage');
      const listA = await http()
        .get(`${API}/branches`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(listA.body.data.map((x: { name: string }) => x.name)).toEqual([
        'A-main',
      ]);

      const toB = await switchTo(accessToken, b.tenantId).expect(200);
      expect(toB.body.data.permissions).not.toContain('branches.manage'); // A's do not carry over
      const listB = await http()
        .get(`${API}/branches`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(listB.body.data.map((x: { name: string }) => x.name)).toEqual([
        'B-main',
      ]);
      await http()
        .post(`${API}/branches`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Nope' })
        .expect(403); // receptionist in B

      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.tenant_switched' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audit.map((x) => x.tenantId)).toEqual([a.tenantId, b.tenantId]);
      expect(audit[0]).toMatchObject({
        entityType: 'session',
        actorUserId: user.id,
      });
    });

    it('a tenant the user does not belong to -> 403 TENANT_ACCESS_DENIED (and nothing changes)', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const stranger = await createActiveUser(owner, 'stranger@example.com');
      const x = await seedMembership(owner, stranger.id, 'clinic-x', ['owner']);
      const { accessToken } = await signIn();
      const res = await switchTo(accessToken, x.tenantId).expect(403);
      expect(res.body.error.code).toBe('TENANT_ACCESS_DENIED');
      const session = await owner.session.findFirstOrThrow();
      expect(session.activeTenantId).toBe(a.tenantId); // the auto-selected one, unchanged
    });

    it('suspended and deactivated tenants and inactive memberships are refused', async () => {
      const s = await seedMembership(owner, user.id, 'clinic-s', ['owner'], {
        tenantStatus: 'suspended',
      });
      const d = await seedMembership(owner, user.id, 'clinic-d', ['owner'], {
        tenantStatus: 'deactivated',
      });
      const m = await seedMembership(owner, user.id, 'clinic-m', ['owner'], {
        membershipStatus: 'suspended',
      });
      const { accessToken } = await signIn();
      expect(
        (await switchTo(accessToken, s.tenantId).expect(403)).body.error.code,
      ).toBe('TENANT_SUSPENDED');
      expect(
        (await switchTo(accessToken, d.tenantId).expect(403)).body.error.code,
      ).toBe('TENANT_DEACTIVATED');
      expect(
        (await switchTo(accessToken, m.tenantId).expect(403)).body.error.code,
      ).toBe('TENANT_ACCESS_DENIED');
    });

    it('validates the body', async () => {
      const { accessToken } = await signIn();
      for (const body of [undefined, 'nope', 123, {}]) {
        const res = await http()
          .post(`${API}/auth/switch-tenant`)
          .set('Authorization', `Bearer ${accessToken}`)
          .send(body === undefined ? {} : { tenantId: body })
          .expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
      const extra = await http()
        .post(`${API}/auth/switch-tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ tenantId: '00000000-0000-4000-8000-000000000000', userId: 'x' })
        .expect(400);
      expect(extra.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('needs authentication', async () => {
      await http()
        .post(`${API}/auth/switch-tenant`)
        .send({ tenantId: '00000000-0000-4000-8000-000000000000' })
        .expect(401);
    });

    it('membership removed while the access token is still valid -> next tenant request 403', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const { accessToken } = await signIn();
      await http()
        .get(`${API}/tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      await owner.tenantMembership.update({
        where: { id: a.membershipId },
        data: { status: 'removed', removedAt: new Date() },
      });
      const res = await http()
        .get(`${API}/tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('TENANT_ACCESS_DENIED');
    });
  });

  describe('Phase 2 isolation with real tokens', () => {
    it('Clinic A users never see Clinic B data, even for B’s ids', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const stranger = await createActiveUser(owner, 'b-owner@example.com');
      const b = await seedMembership(owner, stranger.id, 'clinic-b', ['owner']);
      const bBranch = await owner.branch.create({
        data: { tenantId: b.tenantId, name: 'B-secret' },
      });
      await owner.branch.create({
        data: { tenantId: a.tenantId, name: 'A-main' },
      });

      const { accessToken } = await signIn();
      const list = await http()
        .get(`${API}/branches`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(JSON.stringify(list.body)).not.toContain('B-secret');
      await http()
        .get(`${API}/branches/${bBranch.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
      await http()
        .patch(`${API}/branches/${bBranch.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'hijack' })
        .expect(404);
      const tenant = await http()
        .get(`${API}/tenant`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(tenant.body.data.id).toBe(a.tenantId);
    });
  });
});
