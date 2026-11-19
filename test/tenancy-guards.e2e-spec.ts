import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { AUTHENTICATOR } from '../src/common/auth/authenticator.js';
import { JwtAuthenticator } from '../src/modules/auth/jwt.authenticator.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { bearer } from './support/test-authenticator.js';
import {
  type StandardFixture,
  seedClinic,
  seedStandardFixture,
} from './support/tenancy-fixtures.js';

describe('Guard chain and request context (e2e)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let fx: StandardFixture;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    fx = await seedStandardFixture(owner);
  });

  const http = () => request(app.getHttpServer());
  const get = (path: string, auth?: string) => {
    const r = http().get(`/api/v1/_tenant/${path}`);
    return auth ? r.set('Authorization', auth) : r;
  };
  const aOwner = () =>
    bearer(fx.a.members['a-owner@example.com']!.userId, fx.a.tenantId);

  function expectError(body: any, status: number, code: string) {
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({ status, code });
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  }

  describe('authentication', () => {
    it('no credentials -> 401 UNAUTHENTICATED on a tenant route', async () => {
      const res = await get('read').expect(401);
      expectError(res.body, 401, 'UNAUTHENTICATED');
    });

    it('malformed credentials -> 401', async () => {
      await get('read', 'Bearer garbage').expect(401);
      await get('read', 'Bearer test.not-a-uuid.none').expect(401);
    });

    it('@Public() routes stay reachable without credentials', async () => {
      await get('public').expect(200);
      await http().get('/api/health').expect(200);
    });

    it('the production binding is JwtAuthenticator and refuses a credential it did not issue on every non-public route', async () => {
      const prod = await createTestApp({ productionAuthenticator: true });
      try {
        expect(prod.get(AUTHENTICATOR)).toBeInstanceOf(JwtAuthenticator);
        const auth = aOwner(); // a TestAuthenticator-style bearer, not a JWT
        for (const path of ['read', 'no-tenant', 'manage', 'undecorated']) {
          const res = await request(prod.getHttpServer())
            .get(`/api/v1/_tenant/${path}`)
            .set('Authorization', auth)
            .expect(401);
          expectError(res.body, 401, 'UNAUTHENTICATED');
        }
        for (const path of ['read', 'no-tenant', 'manage', 'undecorated']) {
          const res = await request(prod.getHttpServer())
            .get(`/api/v1/_tenant/${path}`)
            .expect(401); // no credential at all
          expectError(res.body, 401, 'UNAUTHENTICATED');
        }
        await request(prod.getHttpServer())
          .get('/api/v1/_tenant/public')
          .expect(200);
      } finally {
        await prod.close();
      }
    });
  });

  describe('tenant guard', () => {
    it('authenticated without an active tenant -> 403 TENANT_NOT_SELECTED', async () => {
      const res = await get(
        'read',
        bearer(fx.a.members['a-owner@example.com']!.userId, null),
      ).expect(403);
      expectError(res.body, 403, 'TENANT_NOT_SELECTED');
    });

    it('@TenantNotRequired() works with no tenant', async () => {
      const userId = fx.a.members['a-owner@example.com']!.userId;
      const res = await get('no-tenant', bearer(userId, null)).expect(200);
      expect(res.body.data.userId).toBe(userId);
    });

    it('not a member of the requested tenant -> TENANT_ACCESS_DENIED', async () => {
      const outsider = fx.b.members['b-owner@example.com']!.userId;
      const res = await get('read', bearer(outsider, fx.a.tenantId)).expect(
        403,
      );
      expectError(res.body, 403, 'TENANT_ACCESS_DENIED');
    });

    it('a tenant id that does not exist -> TENANT_ACCESS_DENIED (no enumeration)', async () => {
      const userId = fx.a.members['a-owner@example.com']!.userId;
      const res = await get(
        'read',
        bearer(userId, '00000000-0000-4000-8000-000000000000'),
      ).expect(403);
      expectError(res.body, 403, 'TENANT_ACCESS_DENIED');
    });

    it.each(['invited', 'suspended', 'removed'] as const)(
      'membership %s -> TENANT_ACCESS_DENIED',
      async (status) => {
        const clinic = await seedClinic(owner, `c-${status}`, [
          {
            email: `${status}@example.com`,
            roles: ['owner'],
            membershipStatus: status,
          },
        ]);
        const res = await get(
          'read',
          bearer(
            clinic.members[`${status}@example.com`]!.userId,
            clinic.tenantId,
          ),
        ).expect(403);
        expectError(res.body, 403, 'TENANT_ACCESS_DENIED');
      },
    );

    it.each(['deactivated', 'pending'] as const)(
      'user %s -> TENANT_ACCESS_DENIED',
      async (userStatus) => {
        const clinic = await seedClinic(owner, `u-${userStatus}`, [
          { email: `${userStatus}@example.com`, roles: ['owner'], userStatus },
        ]);
        const res = await get(
          'read',
          bearer(
            clinic.members[`${userStatus}@example.com`]!.userId,
            clinic.tenantId,
          ),
        ).expect(403);
        expectError(res.body, 403, 'TENANT_ACCESS_DENIED');
      },
    );

    it('suspended tenant -> TENANT_SUSPENDED, deactivated -> TENANT_DEACTIVATED', async () => {
      const suspended = await seedClinic(
        owner,
        'suspended',
        [{ email: 's@example.com', roles: ['owner'] }],
        { status: 'suspended' },
      );
      const deactivated = await seedClinic(
        owner,
        'deactivated',
        [{ email: 'd@example.com', roles: ['owner'] }],
        { status: 'deactivated' },
      );
      expectError(
        (
          await get(
            'read',
            bearer(
              suspended.members['s@example.com']!.userId,
              suspended.tenantId,
            ),
          ).expect(403)
        ).body,
        403,
        'TENANT_SUSPENDED',
      );
      expectError(
        (
          await get(
            'read',
            bearer(
              deactivated.members['d@example.com']!.userId,
              deactivated.tenantId,
            ),
          ).expect(403)
        ).body,
        403,
        'TENANT_DEACTIVATED',
      );
    });

    it('a non-member learns nothing about a suspended tenant', async () => {
      const suspended = await seedClinic(
        owner,
        'suspended',
        [{ email: 's@example.com', roles: ['owner'] }],
        { status: 'suspended' },
      );
      const outsider = fx.a.members['a-owner@example.com']!.userId;
      const res = await get(
        'read',
        bearer(outsider, suspended.tenantId),
      ).expect(403);
      expectError(res.body, 403, 'TENANT_ACCESS_DENIED');
    });
  });

  describe('permissions guard', () => {
    it('grants a permission held through the role', async () => {
      await get('read', aOwner()).expect(200);
      await get('manage', aOwner()).expect(200);
    });

    it('missing permission -> 403 FORBIDDEN', async () => {
      const recep = bearer(
        fx.a.members['a-recep@example.com']!.userId,
        fx.a.tenantId,
      );
      await get('read', recep).expect(200);
      const res = await get('manage', recep).expect(403);
      expectError(res.body, 403, 'FORBIDDEN');
    });

    it('a tenant-scoped route without @RequirePermissions is denied (deny by default)', async () => {
      const res = await get('undecorated', aOwner()).expect(403);
      expectError(res.body, 403, 'FORBIDDEN');
    });

    it('revoking a role permission denies the NEXT request', async () => {
      await get('manage', aOwner()).expect(200);
      await owner.$executeRawUnsafe(
        `DELETE FROM role_permissions WHERE role_id = $1::uuid AND permission_id = (SELECT id FROM permissions WHERE key = 'branches.manage')`,
        fx.a.roleIds['owner'],
      );
      expectError(
        (await get('manage', aOwner()).expect(403)).body,
        403,
        'FORBIDDEN',
      );
    });

    it('removing the membership denies the NEXT request', async () => {
      await get('read', aOwner()).expect(200);
      await owner.tenantMembership.update({
        where: { id: fx.a.members['a-owner@example.com']!.membershipId },
        data: { status: 'removed' },
      });
      expectError(
        (await get('read', aOwner()).expect(403)).body,
        403,
        'TENANT_ACCESS_DENIED',
      );
    });
  });

  describe('same user, different clinics (user M)', () => {
    it('has owner rights in A and receptionist rights in B', async () => {
      const m = fx.m.userId;
      await get('manage', bearer(m, fx.a.tenantId)).expect(200);
      await get('read', bearer(m, fx.b.tenantId)).expect(200);
      expectError(
        (await get('manage', bearer(m, fx.b.tenantId)).expect(403)).body,
        403,
        'FORBIDDEN',
      );
    });
  });

  describe('request context', () => {
    it('exposes tenant, membership, permissions and request id to handlers', async () => {
      const res = await get('context', aOwner()).expect(200);
      expect(res.body.data).toMatchObject({
        before: fx.a.tenantId,
        after: fx.a.tenantId,
        membershipId: fx.a.members['a-owner@example.com']!.membershipId,
      });
      expect(res.body.data.requestId).toBe(res.headers['x-request-id']);
      expect(res.body.data.permissions).toEqual([
        'branches.manage',
        'branches.read',
        'members.invite',
        'tenant.read',
        'tenant.settings.manage',
      ]);
    });

    it('keeps the tenant after the request body is parsed', async () => {
      const res = await http()
        .post('/api/v1/_tenant/echo')
        .set('Authorization', aOwner())
        .send({ a: 1, b: 2 })
        .expect(201);
      expect(res.body.data).toEqual({ tenantId: fx.a.tenantId, size: 2 });
    });

    it('50 interleaved requests from Clinic A and Clinic B never see each other', async () => {
      const aUser = fx.a.members['a-owner@example.com']!.userId;
      const bUser = fx.b.members['b-owner@example.com']!.userId;
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) => {
          const isA = i % 2 === 0;
          const expected = isA ? fx.a.tenantId : fx.b.tenantId;
          return get('context', bearer(isA ? aUser : bUser, expected)).then(
            (res) => ({ status: res.status, expected, data: res.body.data }),
          );
        }),
      );
      for (const r of results) {
        expect(r.status).toBe(200);
        expect(r.data.before).toBe(r.expected);
        expect(r.data.after).toBe(r.expected);
      }
    });
  });
});
