import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { captureOutput } from './setup/capture-output.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { bearer } from './support/test-authenticator.js';
import {
  type StandardFixture,
  seedStandardFixture,
} from './support/tenancy-fixtures.js';

const MISSING = '00000000-0000-4000-8000-000000000000';

describe('Tenant and branch endpoints: isolation matrix (e2e)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let fx: StandardFixture;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp({
      env: { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' },
    });
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    fx = await seedStandardFixture(owner);
    await owner.branch.createMany({
      data: [
        { tenantId: fx.a.tenantId, name: 'A2' },
        { tenantId: fx.a.tenantId, name: 'A3', isActive: false },
        { tenantId: fx.b.tenantId, name: 'B2' },
        { tenantId: fx.b.tenantId, name: 'B3' },
        { tenantId: fx.b.tenantId, name: 'B4' },
      ],
    });
  });

  const http = () => request(app.getHttpServer());
  const A_OWNER = () =>
    bearer(fx.a.members['a-owner@example.com']!.userId, fx.a.tenantId);
  const A_RECEP = () =>
    bearer(fx.a.members['a-recep@example.com']!.userId, fx.a.tenantId);
  const B_OWNER = () =>
    bearer(fx.b.members['b-owner@example.com']!.userId, fx.b.tenantId);
  const M_IN_A = () => bearer(fx.m.userId, fx.a.tenantId);
  const M_IN_B = () => bearer(fx.m.userId, fx.b.tenantId);
  const bBranch = (name: string) =>
    owner.branch.findFirstOrThrow({ where: { tenantId: fx.b.tenantId, name } });

  function expectError(body: any, status: number, code: string) {
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({ status, code });
  }
  /** field -> every code reported for it (a field can fail several rules). */
  const fieldCodes = (body: any) => {
    const out: Record<string, string[]> = {};
    for (const d of body.error.details ?? [])
      (out[d.field] ??= []).push(d.code);
    return out;
  };

  describe('authentication', () => {
    it.each([
      ['get', '/api/v1/tenant'],
      ['patch', '/api/v1/tenant'],
      ['get', '/api/v1/branches'],
      ['post', '/api/v1/branches'],
      ['get', `/api/v1/branches/${MISSING}`],
      ['patch', `/api/v1/branches/${MISSING}`],
    ] as const)('%s %s without credentials -> 401', async (method, path) => {
      const res = await http()[method](path).expect(401);
      expectError(res.body, 401, 'UNAUTHENTICATED');
    });
  });

  describe('GET /tenant', () => {
    it('returns only the active tenant profile', async () => {
      const a = await http()
        .get('/api/v1/tenant')
        .set('Authorization', A_OWNER())
        .expect(200);
      expect(Object.keys(a.body)).toEqual(['data']);
      expect(a.body.data).toMatchObject({
        id: fx.a.tenantId,
        slug: 'clinic-a',
        status: 'active',
        timezone: 'Asia/Manila',
      });
      const b = await http()
        .get('/api/v1/tenant')
        .set('Authorization', B_OWNER())
        .expect(200);
      expect(b.body.data.id).toBe(fx.b.tenantId);
    });

    it('is readable by a receptionist (tenant.read)', async () => {
      await http()
        .get('/api/v1/tenant')
        .set('Authorization', A_RECEP())
        .expect(200);
    });
  });

  describe('PATCH /tenant', () => {
    const patch = (auth: string, body: object) =>
      http().patch('/api/v1/tenant').set('Authorization', auth).send(body);

    it('updates allowed fields and audits only the changed field names', async () => {
      const res = await patch(A_OWNER(), {
        name: 'Clinic A Renamed',
        timezone: 'Asia/Tokyo',
        contactEmail: 'front@clinic-a.example',
        contactPhone: '+639171234567',
      }).expect(200);
      expect(res.body.data).toMatchObject({
        name: 'Clinic A Renamed',
        timezone: 'Asia/Tokyo',
        contactEmail: 'front@clinic-a.example',
        contactPhone: '+639171234567',
      });
      const logs = await owner.auditLog.findMany({
        where: { action: 'tenant.updated' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        tenantId: fx.a.tenantId,
        entityType: 'tenant',
        entityId: fx.a.tenantId,
        actorMembershipId: fx.a.members['a-owner@example.com']!.membershipId,
        requestId: res.headers['x-request-id'],
      });
      expect([...logs[0]!.changedFields].sort()).toEqual([
        'contactEmail',
        'contactPhone',
        'name',
        'timezone',
      ]);
      expect(JSON.stringify(logs[0])).not.toContain('Clinic A Renamed');
      expect(JSON.stringify(logs[0])).not.toContain('front@clinic-a.example');
    });

    it('can clear contact fields with null; a no-op patch writes no audit row', async () => {
      await patch(A_OWNER(), { contactEmail: 'x@clinic-a.example' }).expect(
        200,
      );
      await patch(A_OWNER(), { contactEmail: null }).expect(200);
      expect(
        (await owner.tenant.findUniqueOrThrow({ where: { id: fx.a.tenantId } }))
          .contactEmail,
      ).toBeNull();
      const before = await owner.auditLog.count();
      await patch(A_OWNER(), {}).expect(200);
      await patch(A_OWNER(), { name: 'clinic-a' }).expect(200); // same value
      expect(await owner.auditLog.count()).toBe(before);
    });

    it('never touches another tenant', async () => {
      await patch(A_OWNER(), { name: 'Only A' }).expect(200);
      expect(
        (await owner.tenant.findUniqueOrThrow({ where: { id: fx.b.tenantId } }))
          .name,
      ).toBe('clinic-b');
    });

    it('slug, status and tenantId are not accepted -> 400 VALIDATION_FAILED', async () => {
      for (const body of [
        { slug: 'hijack' },
        { status: 'suspended' },
        { tenantId: fx.b.tenantId },
      ]) {
        const res = await patch(A_OWNER(), body).expect(400);
        expectError(res.body, 400, 'VALIDATION_FAILED');
        expect(Object.values(fieldCodes(res.body)).flat()).toContain(
          'UNKNOWN_FIELD',
        );
      }
      const tenant = await owner.tenant.findUniqueOrThrow({
        where: { id: fx.a.tenantId },
      });
      expect(tenant).toMatchObject({ slug: 'clinic-a', status: 'active' });
    });

    it.each([
      ['name', { name: '' }, 'REQUIRED'],
      ['name', { name: 'x'.repeat(121) }, 'TOO_LONG'],
      ['name', { name: null }, undefined],
      ['timezone', { timezone: 'Mars/Olympus' }, 'INVALID_VALUE'],
      ['timezone', { timezone: '+08:00' }, 'INVALID_VALUE'],
      ['contactEmail', { contactEmail: 'nope' }, 'INVALID_FORMAT'],
      ['contactPhone', { contactPhone: '09171234567' }, 'INVALID_FORMAT'],
      ['contactPhone', { contactPhone: '+1' }, 'INVALID_FORMAT'],
    ])('invalid %s -> 400 with field details', async (field, body, code) => {
      const res = await patch(A_OWNER(), body).expect(400);
      expectError(res.body, 400, 'VALIDATION_FAILED');
      expect(Object.keys(fieldCodes(res.body))).toContain(field);
      if (code) expect(fieldCodes(res.body)[field]).toContain(code);
    });

    it('a receptionist cannot patch (403) and nothing changes', async () => {
      const res = await patch(A_RECEP(), { name: 'nope' }).expect(403);
      expectError(res.body, 403, 'FORBIDDEN');
      expect(
        (await owner.tenant.findUniqueOrThrow({ where: { id: fx.a.tenantId } }))
          .name,
      ).toBe('clinic-a');
    });
  });

  describe('GET /branches', () => {
    it('lists only the tenant branches; totals count only that tenant', async () => {
      const res = await http()
        .get('/api/v1/branches')
        .set('Authorization', A_OWNER())
        .expect(200);
      expect(res.body.data.map((b: any) => b.name)).toEqual([
        'A2',
        'A3',
        'Main',
      ]);
      expect(res.body.meta).toEqual({
        page: 1,
        pageSize: 20,
        totalItems: 3,
        totalPages: 1,
      });
      const b = await http()
        .get('/api/v1/branches')
        .set('Authorization', B_OWNER())
        .expect(200);
      expect(b.body.meta.totalItems).toBe(4);
    });

    it('paginates and filters by isActive', async () => {
      const page = await http()
        .get('/api/v1/branches?page=2&pageSize=2')
        .set('Authorization', A_OWNER())
        .expect(200);
      expect(page.body.data.map((b: any) => b.name)).toEqual(['Main']);
      expect(page.body.meta).toEqual({
        page: 2,
        pageSize: 2,
        totalItems: 3,
        totalPages: 2,
      });
      const inactive = await http()
        .get('/api/v1/branches?isActive=false')
        .set('Authorization', A_OWNER())
        .expect(200);
      expect(inactive.body.data.map((b: any) => b.name)).toEqual(['A3']);
    });

    it('pageSize 100 is accepted, 101 is not; invalid paging -> 400', async () => {
      await http()
        .get('/api/v1/branches?pageSize=100')
        .set('Authorization', A_OWNER())
        .expect(200);
      for (const q of [
        'pageSize=101',
        'pageSize=0',
        'page=0',
        'page=abc',
        'isActive=maybe',
      ]) {
        const res = await http()
          .get(`/api/v1/branches?${q}`)
          .set('Authorization', A_OWNER())
          .expect(400);
        expectError(res.body, 400, 'VALIDATION_FAILED');
      }
    });

    it('a tenantId in the query is rejected, not honoured', async () => {
      const res = await http()
        .get(`/api/v1/branches?tenantId=${fx.b.tenantId}`)
        .set('Authorization', A_OWNER())
        .expect(400);
      expectError(res.body, 400, 'VALIDATION_FAILED');
    });

    it('a receptionist can list (branches.read)', async () => {
      await http()
        .get('/api/v1/branches')
        .set('Authorization', A_RECEP())
        .expect(200);
    });
  });

  describe('GET /branches/:branchId', () => {
    it('returns an own branch', async () => {
      const res = await http()
        .get(`/api/v1/branches/${fx.a.branchId}`)
        .set('Authorization', A_OWNER())
        .expect(200);
      expect(res.body.data).toMatchObject({
        id: fx.a.branchId,
        name: 'Main',
        isActive: true,
      });
      expect(res.body.data).not.toHaveProperty('tenantId');
    });

    it("another tenant's id -> 404 (never 403)", async () => {
      const target = await bBranch('B2');
      const res = await http()
        .get(`/api/v1/branches/${target.id}`)
        .set('Authorization', A_OWNER())
        .expect(404);
      expectError(res.body, 404, 'NOT_FOUND');
    });

    it('unknown id -> 404; malformed id -> 400', async () => {
      await http()
        .get(`/api/v1/branches/${MISSING}`)
        .set('Authorization', A_OWNER())
        .expect(404);
      const res = await http()
        .get('/api/v1/branches/not-a-uuid')
        .set('Authorization', A_OWNER())
        .expect(400);
      expectError(res.body, 400, 'VALIDATION_FAILED');
      expect(fieldCodes(res.body)['branchId']).toContain('INVALID_FORMAT');
    });
  });

  describe('POST /branches', () => {
    const post = (auth: string, body: object) =>
      http().post('/api/v1/branches').set('Authorization', auth).send(body);

    it('creates a branch in the active tenant, audited without values', async () => {
      const res = await post(A_OWNER(), {
        name: 'SECRET-BRANCH-NAME',
        addressLine: '1 Rizal St',
        city: 'Cebu',
        province: 'Cebu',
        timezone: 'Asia/Manila',
      }).expect(201);
      expect(res.body.data).toMatchObject({
        name: 'SECRET-BRANCH-NAME',
        city: 'Cebu',
        isActive: true,
      });
      const row = await owner.branch.findUniqueOrThrow({
        where: { id: res.body.data.id },
      });
      expect(row.tenantId).toBe(fx.a.tenantId);
      const logs = await owner.auditLog.findMany({
        where: { action: 'branch.created' },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        tenantId: fx.a.tenantId,
        entityType: 'branch',
        entityId: row.id,
        actorMembershipId: fx.a.members['a-owner@example.com']!.membershipId,
        requestId: res.headers['x-request-id'],
      });
      expect(JSON.stringify(logs[0])).not.toContain('SECRET-BRANCH-NAME');
    });

    it('a duplicate name inside the tenant -> 409; the same name in another tenant is fine', async () => {
      const res = await post(A_OWNER(), { name: 'Main' }).expect(409);
      expectError(res.body, 409, 'CONFLICT_UNIQUE');
      await post(B_OWNER(), { name: 'Main' }).expect(409); // B has its own Main
      await post(B_OWNER(), { name: 'Only-In-B' }).expect(201);
      await post(A_OWNER(), { name: 'Only-In-B' }).expect(201);
    });

    it('failed requests leave no audit row', async () => {
      await post(A_OWNER(), { name: 'Main' }).expect(409);
      expect(
        await owner.auditLog.count({ where: { action: 'branch.created' } }),
      ).toBe(0);
    });

    it('a body tenantId is rejected and nothing is created', async () => {
      const res = await post(A_OWNER(), {
        name: 'Sneaky',
        tenantId: fx.b.tenantId,
      }).expect(400);
      expectError(res.body, 400, 'VALIDATION_FAILED');
      expect(fieldCodes(res.body)['tenantId']).toContain('UNKNOWN_FIELD');
      expect(await owner.branch.count({ where: { name: 'Sneaky' } })).toBe(0);
    });

    it.each([
      ['name', {}, 'REQUIRED'],
      ['name', { name: '   ' }, 'REQUIRED'],
      ['name', { name: 'x'.repeat(121) }, 'TOO_LONG'],
      ['timezone', { name: 'ok', timezone: 'Nowhere/Land' }, 'INVALID_VALUE'],
      ['city', { name: 'ok', city: 'c'.repeat(121) }, 'TOO_LONG'],
      ['isActive', { name: 'ok', isActive: 'yes' }, undefined],
    ])('invalid %s -> 400', async (field, body, code) => {
      const res = await post(A_OWNER(), body).expect(400);
      expectError(res.body, 400, 'VALIDATION_FAILED');
      expect(Object.keys(fieldCodes(res.body))).toContain(field);
      if (code) expect(fieldCodes(res.body)[field]).toContain(code);
    });

    it('a receptionist -> 403 and nothing is created', async () => {
      const res = await post(A_RECEP(), { name: 'Nope' }).expect(403);
      expectError(res.body, 403, 'FORBIDDEN');
      expect(await owner.branch.count({ where: { name: 'Nope' } })).toBe(0);
    });
  });

  describe('PATCH /branches/:branchId', () => {
    const patch = (auth: string, id: string, body: object) =>
      http()
        .patch(`/api/v1/branches/${id}`)
        .set('Authorization', auth)
        .send(body);

    it("another tenant's branch -> 404 and the row is unchanged", async () => {
      const target = await bBranch('B2');
      const res = await patch(A_OWNER(), target.id, {
        name: 'hacked',
        isActive: false,
      }).expect(404);
      expectError(res.body, 404, 'NOT_FOUND');
      const after = await bBranch('B2');
      expect(after).toMatchObject({ name: 'B2', isActive: true });
      expect(await owner.auditLog.count()).toBe(0);
    });

    it('updates an own branch (including deactivation) and audits field names', async () => {
      const res = await patch(A_OWNER(), fx.a.branchId, {
        city: 'Davao',
        isActive: false,
      }).expect(200);
      expect(res.body.data).toMatchObject({
        id: fx.a.branchId,
        city: 'Davao',
        isActive: false,
      });
      const [log] = await owner.auditLog.findMany({
        where: { action: 'branch.updated' },
      });
      expect(log).toMatchObject({
        tenantId: fx.a.tenantId,
        entityId: fx.a.branchId,
        actorMembershipId: fx.a.members['a-owner@example.com']!.membershipId,
      });
      expect([...log!.changedFields].sort()).toEqual(['city', 'isActive']);
      expect(JSON.stringify(log)).not.toContain('Davao');
    });

    it('renaming to an existing name in the tenant -> 409', async () => {
      const res = await patch(A_OWNER(), fx.a.branchId, { name: 'A2' }).expect(
        409,
      );
      expectError(res.body, 409, 'CONFLICT_UNIQUE');
    });

    it('tenantId in the body is rejected; a receptionist gets 403', async () => {
      await patch(A_OWNER(), fx.a.branchId, { tenantId: fx.b.tenantId }).expect(
        400,
      );
      await patch(A_RECEP(), fx.a.branchId, { name: 'nope' }).expect(403);
      expect(
        (await owner.branch.findUniqueOrThrow({ where: { id: fx.a.branchId } }))
          .name,
      ).toBe('Main');
    });

    it('malformed id -> 400; unknown id -> 404', async () => {
      await patch(A_OWNER(), 'nope', { name: 'x' }).expect(400);
      await patch(A_OWNER(), MISSING, { name: 'x' }).expect(404);
    });
  });

  describe('no hard delete', () => {
    it('DELETE /branches/:id does not exist', async () => {
      const res = await http()
        .delete(`/api/v1/branches/${fx.a.branchId}`)
        .set('Authorization', A_OWNER())
        .expect(404);
      expectError(res.body, 404, 'ROUTE_NOT_FOUND');
    });
  });

  describe('user M (owner in A, receptionist in B)', () => {
    it('gets the rights of the clinic named by the token', async () => {
      await http()
        .post('/api/v1/branches')
        .set('Authorization', M_IN_A())
        .send({ name: 'M-in-A' })
        .expect(201);
      const read = await http()
        .get('/api/v1/branches')
        .set('Authorization', M_IN_B())
        .expect(200);
      expect(
        read.body.data.every(
          (b: any) => !b.name.startsWith('A') && b.name !== 'M-in-A',
        ),
      ).toBe(true);
      const denied = await http()
        .post('/api/v1/branches')
        .set('Authorization', M_IN_B())
        .send({ name: 'M-in-B' })
        .expect(403);
      expectError(denied.body, 403, 'FORBIDDEN');
      expect(await owner.branch.count({ where: { name: 'M-in-B' } })).toBe(0);
      const patchB = await http()
        .patch('/api/v1/tenant')
        .set('Authorization', M_IN_B())
        .send({ name: 'x' })
        .expect(403);
      expectError(patchB.body, 403, 'FORBIDDEN');
    });
  });

  describe('logging', () => {
    it('request data never reaches the logs', async () => {
      const capture = captureOutput();
      try {
        await http()
          .post('/api/v1/branches')
          .set('Authorization', A_OWNER())
          .send({ name: 'LOG-LEAK-CANARY', addressLine: 'CANARY-ADDRESS' })
          .expect(201);
        await http()
          .get('/api/v1/branches?isActive=true')
          .set('Authorization', A_OWNER())
          .expect(200);
        await http()
          .patch('/api/v1/tenant')
          .set('Authorization', A_RECEP())
          .send({ name: 'CANARY-TENANT' })
          .expect(403);
      } finally {
        capture.restore();
      }
      const text = capture.text();
      expect(text).not.toContain('LOG-LEAK-CANARY');
      expect(text).not.toContain('CANARY-ADDRESS');
      expect(text).not.toContain('CANARY-TENANT');
    });
  });

  describe('Swagger', () => {
    it('documents every new endpoint', async () => {
      const json = await http().get('/api/docs-json').expect(200);
      expect(Object.keys(json.body.paths)).toEqual(
        expect.arrayContaining([
          '/api/v1/tenant',
          '/api/v1/branches',
          '/api/v1/branches/{branchId}',
        ]),
      );
      expect(Object.keys(json.body.paths['/api/v1/tenant'])).toEqual(
        expect.arrayContaining(['get', 'patch']),
      );
      expect(Object.keys(json.body.paths['/api/v1/branches'])).toEqual(
        expect.arrayContaining(['get', 'post']),
      );
      expect(
        Object.keys(json.body.paths['/api/v1/branches/{branchId}']),
      ).toEqual(expect.arrayContaining(['get', 'patch']));
    });
  });
});
