import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { DEV_SEED, seedDev } from '../src/dev/seed.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';

describe('development seed (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp({ productionAuthenticator: true });
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    (app.get(ThrottlerStorage) as ResettableThrottlerStorage).reset();
    await resetTenancyData(owner);
  });

  const login = (email: string) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email, password: DEV_SEED.password });

  it('creates a clinic whose owner can sign in right away and manage it', async () => {
    const result = await seedDev(app);
    expect(result.created).toBe(true);

    const res = await login(DEV_SEED.ownerEmail).expect(200);
    expect(res.body.data.activeTenantId).toBe(result.tenantId);
    expect(res.body.data.memberships).toEqual([
      expect.objectContaining({
        tenantName: DEV_SEED.clinicName,
        roles: ['Owner'],
      }),
    ]);
    const auth = {
      Authorization: `Bearer ${res.body.data.accessToken as string}`,
    };

    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set(auth)
      .expect(200);
    expect(me.body.data.permissions).toContain('branches.manage');
    const branches = await request(app.getHttpServer())
      .get('/api/v1/branches')
      .set(auth)
      .expect(200);
    expect(
      branches.body.data.map((b: { name: string }) => b.name).sort(),
    ).toEqual(['Main', DEV_SEED.secondBranchName].sort());
  });

  it('also creates a receptionist, so the frontend can see a restricted role', async () => {
    await seedDev(app);
    const res = await login(DEV_SEED.receptionistEmail).expect(200);
    const auth = {
      Authorization: `Bearer ${res.body.data.accessToken as string}`,
    };
    const me = await request(app.getHttpServer())
      .get('/api/v1/me')
      .set(auth)
      .expect(200);
    expect(me.body.data.permissions).toEqual(['branches.read', 'tenant.read']);
    await request(app.getHttpServer())
      .post('/api/v1/branches')
      .set(auth)
      .send({ name: 'Nope' })
      .expect(403);
  });

  it('is idempotent: running again creates nothing new and the logins still work', async () => {
    const first = await seedDev(app);
    const second = await seedDev(app);
    expect(second.created).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(await owner.tenant.count()).toBe(1);
    expect(await owner.user.count()).toBe(2);
    expect(await owner.branch.count()).toBe(2);
    await login(DEV_SEED.ownerEmail).expect(200);
    await login(DEV_SEED.receptionistEmail).expect(200);
  });

  it('leaves no usable setup link behind (the owner is already active)', async () => {
    await seedDev(app);
    const open = await owner.userToken.count({
      where: { type: 'account_setup', usedAt: null },
    });
    expect(open).toBe(0);
  });
});
