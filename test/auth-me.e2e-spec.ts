import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  seedMembership,
  type TestUser,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';
import { DAY, TestClock } from './support/test-clock.js';

const API = '/api/v1';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('current user: /me, memberships and sessions (real PostgreSQL)', () => {
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
    user = await createActiveUser(owner, 'doc@example.com', {
      fullName: 'Dr. Doc',
    });
  });

  const http = () => request(app.getHttpServer());
  const signIn = async (who: TestUser = user, userAgent = 'TestAgent/1') => {
    const res = await http()
      .post(`${API}/auth/login`)
      .set('User-Agent', userAgent)
      .send({ email: who.email, password: who.password })
      .expect(200);
    return res.body.data.accessToken as string;
  };
  const authed = (method: 'get' | 'delete', path: string, token: string) =>
    http()[method](`${API}${path}`).set('Authorization', `Bearer ${token}`);

  it.each([
    ['get', '/me'],
    ['get', '/me/memberships'],
    ['get', '/me/sessions'],
    ['delete', `/me/sessions/${MISSING}`],
  ] as const)('%s %s needs authentication', async (method, path) => {
    const res = await http()[method](`${API}${path}`).expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  describe('GET /me', () => {
    it('returns the profile with no secrets, and no permissions without an active tenant', async () => {
      const token = await signIn();
      const res = await authed('get', '/me', token).expect(200);
      expect(res.body.data).toMatchObject({
        id: user.id,
        email: user.email,
        fullName: 'Dr. Doc',
        activeTenantId: null,
        permissions: [],
      });
      expect(typeof res.body.data.emailVerifiedAt).toBe('string');
      expect(typeof res.body.data.passwordChangedAt).toBe('string');
      const text = JSON.stringify(res.body);
      for (const secret of [
        'passwordHash',
        'password_hash',
        'argon2',
        'failedLoginCount',
        'lockedUntil',
      ]) {
        expect(text).not.toContain(secret);
      }
    });

    it('lists the effective permissions in the ACTIVE tenant only', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      await seedMembership(owner, user.id, 'clinic-b', ['receptionist']);
      const token = await signIn();
      await http()
        .post(`${API}/auth/switch-tenant`)
        .set('Authorization', `Bearer ${token}`)
        .send({ tenantId: a.tenantId })
        .expect(200);
      const res = await authed('get', '/me', token).expect(200);
      expect(res.body.data.activeTenantId).toBe(a.tenantId);
      expect(res.body.data.permissions).toEqual([
        'branches.manage',
        'branches.read',
        'members.invite',
        'tenant.read',
        'tenant.settings.manage',
      ]);
    });

    it('permissions are empty once the membership is no longer active', async () => {
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const token = await signIn();
      expect(
        (await authed('get', '/me', token).expect(200)).body.data
          .activeTenantId,
      ).toBe(a.tenantId);
      await owner.tenantMembership.update({
        where: { id: a.membershipId },
        data: { status: 'suspended' },
      });
      const res = await authed('get', '/me', token).expect(200);
      expect(res.body.data.permissions).toEqual([]);
    });
  });

  describe('GET /me/memberships', () => {
    it('lists every membership with tenant name, status and role names, without removed ones', async () => {
      await seedMembership(owner, user.id, 'clinic-a', ['owner', 'doctor']);
      await seedMembership(owner, user.id, 'clinic-b', ['receptionist'], {
        tenantStatus: 'suspended',
      });
      await seedMembership(owner, user.id, 'clinic-c', ['owner'], {
        membershipStatus: 'removed',
      });
      const token = await signIn();
      const res = await authed('get', '/me/memberships', token).expect(200);
      expect(
        res.body.data.map((m: { tenantName: string }) => m.tenantName),
      ).toEqual(['clinic-a', 'clinic-b']);
      expect(res.body.data[0]).toMatchObject({
        tenantStatus: 'active',
        membershipStatus: 'active',
        roles: [
          { key: 'doctor', name: 'Doctor' },
          { key: 'owner', name: 'Owner' },
        ],
      });
      expect(res.body.data[1]).toMatchObject({
        tenantStatus: 'suspended',
        roles: [{ key: 'receptionist', name: 'Receptionist' }],
      });
    });

    it('never shows another user’s memberships', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      await seedMembership(owner, other.id, 'secret-clinic', ['owner']);
      const token = await signIn();
      const res = await authed('get', '/me/memberships', token).expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('sessions', () => {
    it('lists active sessions with the current one flagged, and nothing sensitive', async () => {
      const first = await signIn(user, 'Firefox/1');
      const second = await signIn(user, 'Chrome/2');
      const res = await authed('get', '/me/sessions', second).expect(200);
      expect(res.body.data).toHaveLength(2);
      const current = res.body.data.filter(
        (s: { current: boolean }) => s.current,
      );
      expect(current).toHaveLength(1);
      expect(current[0].userAgent).toBe('Chrome/2');
      for (const s of res.body.data) {
        expect(Object.keys(s).sort()).toEqual([
          'createdAt',
          'current',
          'id',
          'ip',
          'lastUsedAt',
          'userAgent',
        ]);
      }
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('tokenHash');
      expect(text).not.toContain(first);
    });

    it('excludes revoked and expired sessions and other users’ sessions', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      await signIn(other);
      const old = await signIn(user, 'Old/1');
      await owner.session.updateMany({
        where: { userAgent: 'Old/1' },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      expect(old).toBeTruthy();
      const live = await signIn(user, 'Live/1');
      const res = await authed('get', '/me/sessions', live).expect(200);
      expect(
        res.body.data.map((s: { userAgent: string }) => s.userAgent),
      ).toEqual(['Live/1']);

      clock.advance(31 * DAY);
      // everything is past its absolute lifetime now: a fresh login lists only itself
      const fresh = await signIn(user, 'Fresh/1');
      const after = await authed('get', '/me/sessions', fresh).expect(200);
      expect(
        after.body.data.map((s: { userAgent: string }) => s.userAgent),
      ).toEqual(['Fresh/1']);
    });

    it('DELETE revokes one of the caller’s own sessions (204) and audits it', async () => {
      const keep = await signIn(user, 'Keep/1');
      const drop = await signIn(user, 'Drop/1');
      const sessions = await authed('get', '/me/sessions', keep).expect(200);
      const target = sessions.body.data.find(
        (s: { userAgent: string }) => s.userAgent === 'Drop/1',
      );
      await authed('delete', `/me/sessions/${target.id}`, keep).expect(204);
      await authed('get', '/me', drop).expect(401); // the revoked session's token is dead
      await authed('get', '/me', keep).expect(200);
      const row = await owner.session.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(row.revokedReason).toBe('logout');
      const audit = await owner.auditLog.findMany({
        where: { action: 'auth.session_revoked' },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        entityType: 'session',
        entityId: target.id,
        tenantId: null,
        actorUserId: user.id,
      });
    });

    it('may revoke the current session too', async () => {
      const token = await signIn();
      const list = await authed('get', '/me/sessions', token).expect(200);
      await authed(
        'delete',
        `/me/sessions/${list.body.data[0].id}`,
        token,
      ).expect(204);
      await authed('get', '/me', token).expect(401);
    });

    it('another user’s session id, an unknown id and an already-revoked id are all 404', async () => {
      const other = await createActiveUser(owner, 'other@example.com');
      const otherToken = await signIn(other, 'Other/1');
      const otherList = await authed('get', '/me/sessions', otherToken).expect(
        200,
      );
      const token = await signIn();
      for (const id of [otherList.body.data[0].id, MISSING]) {
        const res = await authed('delete', `/me/sessions/${id}`, token).expect(
          404,
        );
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      await authed('get', '/me', otherToken).expect(200); // untouched
      const mine = await authed('get', '/me/sessions', token).expect(200);
      const id = mine.body.data[0].id;
      const second = await signIn(user, 'Second/1');
      await authed('delete', `/me/sessions/${id}`, second).expect(204);
      await authed('delete', `/me/sessions/${id}`, second).expect(404);
    });

    it('validates the session id', async () => {
      const token = await signIn();
      const res = await authed(
        'delete',
        '/me/sessions/not-a-uuid',
        token,
      ).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });
});
