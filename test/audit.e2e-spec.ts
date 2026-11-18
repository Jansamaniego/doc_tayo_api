import type { NestExpressApplication } from '@nestjs/platform-express';
import { RequestContext } from '../src/context/request-context.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TenantPrismaService } from '../src/prisma/tenant-prisma.service.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import {
  type StandardFixture,
  seedStandardFixture,
} from './support/tenancy-fixtures.js';

const REQUEST_ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('AuditService (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let audit: AuditService;
  let prisma: PrismaService;
  let tenantDb: TenantPrismaService;
  let fx: StandardFixture;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp();
    audit = app.get(AuditService);
    prisma = app.get(PrismaService);
    tenantDb = app.get(TenantPrismaService);
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    fx = await seedStandardFixture(owner);
  });

  const asOwnerOfA = <T>(fn: () => Promise<T>) =>
    RequestContext.run(
      { requestId: REQUEST_ID, ip: '198.51.100.4' },
      async () => {
        const member = fx.a.members['a-owner@example.com']!;
        app.get(RequestContext).set({
          userId: member.userId,
          tenantId: fx.a.tenantId,
          membershipId: member.membershipId,
        });
        return await fn();
      },
    );

  it('writes inside a tenant-client transaction with tenant, actor and request metadata', async () => {
    await asOwnerOfA(() =>
      tenantDb.$transaction(async (tx) => {
        await tx.branch.create({
          data: { name: 'New', tenantId: fx.a.tenantId },
        });
        await audit.record(tx, {
          action: 'branch.created',
          entityType: 'branch',
          changedFields: ['name'],
        });
      }),
    );
    const rows = await owner.auditLog.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: fx.a.tenantId,
      actorUserId: fx.a.members['a-owner@example.com']!.userId,
      actorMembershipId: fx.a.members['a-owner@example.com']!.membershipId,
      action: 'branch.created',
      entityType: 'branch',
      changedFields: ['name'],
      requestId: REQUEST_ID,
      ip: '198.51.100.4',
    });
  });

  it('is atomic with the business write: a rollback leaves no audit row', async () => {
    await expect(
      asOwnerOfA(() =>
        tenantDb.$transaction(async (tx) => {
          await tx.branch.create({
            data: { name: 'Doomed', tenantId: fx.a.tenantId },
          });
          await audit.record(tx, {
            action: 'branch.created',
            entityType: 'branch',
          });
          throw new Error('boom');
        }),
      ),
    ).rejects.toThrow('boom');
    expect(await owner.auditLog.count()).toBe(0);
    expect(await owner.branch.count({ where: { name: 'Doomed' } })).toBe(0);
  });

  it('writes platform events with no tenant through the unscoped client', async () => {
    await prisma.$transaction(async (tx) => {
      await audit.record(tx, {
        action: 'platform.event',
        entityType: 'platform',
      });
    });
    const [row] = await owner.auditLog.findMany();
    expect(row?.tenantId).toBeNull();
    expect(row?.changedFields).toEqual([]);
  });

  it('an actor membership from another tenant is rejected by the database', async () => {
    const foreign = fx.b.members['b-owner@example.com']!.membershipId;
    await expect(
      prisma.$transaction((tx) =>
        audit.record(tx, {
          action: 'x.y',
          entityType: 'x',
          tenantId: fx.a.tenantId,
          actorMembershipId: foreign,
        }),
      ),
    ).rejects.toThrow();
    expect(await owner.auditLog.count()).toBe(0);
  });
});
