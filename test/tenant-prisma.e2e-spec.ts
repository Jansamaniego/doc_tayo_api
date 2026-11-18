import type { NestExpressApplication } from '@nestjs/platform-express';
import { RequestContext } from '../src/context/request-context.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { TenantPrismaService } from '../src/prisma/tenant-prisma.service.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import {
  type StandardFixture,
  seedStandardFixture,
} from './support/tenancy-fixtures.js';

/**
 * Calls a delegate method with arguments that deliberately break its static
 * types (e.g. create without tenantId, or with a foreign one) while keeping the
 * return type, so the runtime guarantees can be tested.
 */
function loose<D, M extends keyof D>(delegate: D, method: M) {
  type Fn = D[M] extends (...args: never[]) => infer R ? R : never;
  return (args: unknown): Fn =>
    (delegate[method] as (this: D, a: unknown) => Fn).call(delegate, args);
}

describe('TenantPrismaService (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let db: TenantPrismaService;
  let fx: StandardFixture;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp();
    db = app.get(TenantPrismaService);
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    await resetTenancyData(owner);
    fx = await seedStandardFixture(owner);
    // Second branch per clinic so list/count/aggregate have more than one row.
    await owner.branch.create({
      data: { tenantId: fx.a.tenantId, name: 'A2' },
    });
    await owner.branch.create({
      data: { tenantId: fx.b.tenantId, name: 'B2' },
    });
  });

  // Prisma promises are lazy: they run when awaited, so await INSIDE the context.
  const asA = <T>(fn: () => PromiseLike<T>) =>
    RequestContext.run({ tenantId: fx.a.tenantId }, async () => await fn());
  const bBranch = () =>
    owner.branch.findFirstOrThrow({
      where: { tenantId: fx.b.tenantId, name: 'B2' },
    });

  describe('reads are scoped to the tenant in context', () => {
    it('findMany', async () => {
      const rows = await asA(() => db.branch.findMany());
      expect(rows.map((r) => r.name).sort()).toEqual(['A2', 'Main']);
      expect(rows.every((r) => r.tenantId === fx.a.tenantId)).toBe(true);
    });

    it('findMany keeps the caller filter AND the tenant filter (cannot be OR-ed away)', async () => {
      const rows = await asA(() =>
        loose(
          db.branch,
          'findMany',
        )({
          where: { OR: [{ name: 'A2' }, { tenantId: fx.b.tenantId }] },
        }),
      );
      expect(rows.map((r) => r.name)).toEqual(['A2']);
    });

    it('findFirst / findFirstOrThrow', async () => {
      const found = await asA(() =>
        db.branch.findFirst({ where: { name: 'B2' } }),
      );
      expect(found).toBeNull();
      await expect(
        asA(() => db.branch.findFirstOrThrow({ where: { name: 'B2' } })),
      ).rejects.toThrow();
    });

    it('count, aggregate, groupBy', async () => {
      expect(await asA(() => db.branch.count())).toBe(2);
      const agg = await asA(() => db.branch.aggregate({ _count: true }));
      expect(agg._count).toBe(2);
      const groups = await asA(() =>
        db.branch.groupBy({ by: ['tenantId'], _count: true }),
      );
      expect(groups).toHaveLength(1);
      expect(groups[0]?.tenantId).toBe(fx.a.tenantId);
    });

    it('findUnique / findUniqueOrThrow on another tenant id behave as not found', async () => {
      const target = await bBranch();
      expect(
        await asA(() => db.branch.findUnique({ where: { id: target.id } })),
      ).toBeNull();
      await expect(
        asA(() => db.branch.findUniqueOrThrow({ where: { id: target.id } })),
      ).rejects.toThrow();
    });

    it('findUnique on an own id works', async () => {
      const row = await asA(() =>
        db.branch.findUnique({ where: { id: fx.a.branchId } }),
      );
      expect(row?.id).toBe(fx.a.branchId);
    });
  });

  describe('writes cannot touch another tenant', () => {
    it('update / delete of another tenant id fail and leave the row unchanged', async () => {
      const target = await bBranch();
      await expect(
        asA(() =>
          db.branch.update({
            where: { id: target.id },
            data: { name: 'hacked' },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        asA(() => db.branch.delete({ where: { id: target.id } })),
      ).rejects.toThrow();
      expect((await bBranch()).name).toBe('B2');
    });

    it('updateMany / deleteMany only affect the tenant in context', async () => {
      const result = await asA(() =>
        db.branch.updateMany({ data: { city: 'Cebu' } }),
      );
      expect(result.count).toBe(2);
      expect(await owner.branch.count({ where: { city: 'Cebu' } })).toBe(2);
      const removed = await asA(() => db.branch.deleteMany());
      expect(removed.count).toBe(2);
      expect(
        await owner.branch.count({ where: { tenantId: fx.b.tenantId } }),
      ).toBe(2);
    });

    it('upsert updates an own row', async () => {
      const row = await asA(() =>
        loose(
          db.branch,
          'upsert',
        )({
          where: { id: fx.a.branchId },
          update: { city: 'Davao' },
          create: { name: 'unused' },
        }),
      );
      expect(row.city).toBe('Davao');
    });

    it('upsert whose where hits another tenant row takes the create path in OUR tenant', async () => {
      const target = await bBranch();
      const row = await asA(() =>
        loose(
          db.branch,
          'upsert',
        )({
          where: { id: target.id },
          update: { name: 'hacked' },
          create: { name: 'Fresh' },
        }),
      );
      expect(row.tenantId).toBe(fx.a.tenantId);
      expect((await bBranch()).name).toBe('B2');
    });

    it('upsert.update may not change tenantId', async () => {
      await expect(
        asA(() =>
          loose(
            db.branch,
            'upsert',
          )({
            where: { id: fx.a.branchId },
            update: { tenantId: fx.b.tenantId },
            create: { name: 'x' },
          }),
        ),
      ).rejects.toThrow(/tenant/i);
    });
  });

  describe('tenantId is stamped on create and immutable', () => {
    it('create stamps the tenant from context', async () => {
      const row = await asA(() =>
        loose(db.branch, 'create')({ data: { name: 'Stamped' } }),
      );
      expect(row.tenantId).toBe(fx.a.tenantId);
    });

    it('create with the same tenantId is accepted', async () => {
      const row = await asA(() =>
        loose(
          db.branch,
          'create',
        )({ data: { name: 'Same', tenantId: fx.a.tenantId } }),
      );
      expect(row.tenantId).toBe(fx.a.tenantId);
    });

    it('create with a different tenantId throws and writes nothing', async () => {
      await expect(
        asA(() =>
          db.branch.create({ data: { name: 'Evil', tenantId: fx.b.tenantId } }),
        ),
      ).rejects.toThrow(/tenant/i);
      expect(await owner.branch.count({ where: { name: 'Evil' } })).toBe(0);
    });

    it('create with a tenant relation (nested connect) throws', async () => {
      await expect(
        asA(() =>
          db.branch.create({
            data: { name: 'Evil', tenant: { connect: { id: fx.b.tenantId } } },
          }),
        ),
      ).rejects.toThrow(/tenant/i);
    });

    it('createMany / createManyAndReturn stamp every row and reject foreign ones', async () => {
      const made = await asA(() =>
        loose(
          db.branch,
          'createManyAndReturn',
        )({ data: [{ name: 'M1' }, { name: 'M2' }] }),
      );
      expect(made.every((r) => r.tenantId === fx.a.tenantId)).toBe(true);
      await asA(() => loose(db.branch, 'createMany')({ data: { name: 'M3' } }));
      expect(
        (await owner.branch.findFirstOrThrow({ where: { name: 'M3' } }))
          .tenantId,
      ).toBe(fx.a.tenantId);
      await expect(
        asA(() =>
          loose(
            db.branch,
            'createMany',
          )({
            data: [{ name: 'ok' }, { name: 'bad', tenantId: fx.b.tenantId }],
          }),
        ),
      ).rejects.toThrow(/tenant/i);
      expect(
        await owner.branch.count({ where: { name: { in: ['ok', 'bad'] } } }),
      ).toBe(0);
    });

    it('update / updateMany may not change tenantId', async () => {
      await expect(
        asA(() =>
          loose(
            db.branch,
            'update',
          )({
            where: { id: fx.a.branchId },
            data: { tenantId: fx.b.tenantId },
          }),
        ),
      ).rejects.toThrow(/tenant/i);
      await expect(
        asA(() => db.branch.updateMany({ data: { tenantId: fx.b.tenantId } })),
      ).rejects.toThrow(/tenant/i);
      expect(
        (await owner.branch.findUniqueOrThrow({ where: { id: fx.a.branchId } }))
          .tenantId,
      ).toBe(fx.a.tenantId);
    });
  });

  describe('fails closed', () => {
    it('any operation without a tenant in context throws', async () => {
      await expect(db.branch.findMany()).rejects.toThrow(/tenant/i);
      await expect(
        loose(db.branch, 'create')({ data: { name: 'x' } }),
      ).rejects.toThrow(/tenant/i);
      await expect(
        RequestContext.run({ userId: 'u' }, () => db.branch.findMany()),
      ).rejects.toThrow(/tenant/i);
    });

    it('does not expose raw SQL or global models', () => {
      const client = db as unknown as Record<string, unknown>;
      for (const name of [
        '$queryRaw',
        '$executeRaw',
        '$queryRawUnsafe',
        '$executeRawUnsafe',
        'user',
        'tenant',
        'permission',
      ]) {
        expect(client[name]).toBeUndefined();
      }
    });
  });

  describe('interactive transactions', () => {
    it('apply the same scoping and stamping', async () => {
      const result = await asA(() =>
        db.$transaction(async (tx) => {
          await loose(tx.branch, 'create')({ data: { name: 'InTx' } });
          return tx.branch.findMany();
        }),
      );
      expect(result.map((r) => r.name).sort()).toEqual(['A2', 'InTx', 'Main']);
      expect(result.every((r) => r.tenantId === fx.a.tenantId)).toBe(true);
    });

    it('roll back as a unit', async () => {
      await expect(
        asA(() =>
          db.$transaction(async (tx) => {
            await loose(tx.branch, 'create')({ data: { name: 'Doomed' } });
            throw new Error('boom');
          }),
        ),
      ).rejects.toThrow('boom');
      expect(await owner.branch.count({ where: { name: 'Doomed' } })).toBe(0);
    });

    it('do not expose raw SQL', async () => {
      await asA(() =>
        db.$transaction((tx) => {
          expect(
            (tx as unknown as Record<string, unknown>)['$queryRaw'],
          ).toBeUndefined();
          return Promise.resolve();
        }),
      );
    });

    it('enforce the missing-tenant rule inside the transaction', async () => {
      await expect(
        db.$transaction((tx) => tx.branch.findMany()),
      ).rejects.toThrow(/tenant/i);
    });
  });

  describe('relations', () => {
    it('a nested include never yields another tenant rows', async () => {
      const memberships = await asA(() =>
        db.tenantMembership.findMany({
          include: { roles: { include: { role: true } } },
        }),
      );
      expect(memberships).toHaveLength(3);
      for (const m of memberships) {
        expect(m.tenantId).toBe(fx.a.tenantId);
        for (const mr of m.roles) {
          expect(mr.tenantId).toBe(fx.a.tenantId);
          expect(mr.role.tenantId).toBe(fx.a.tenantId);
        }
      }
    });

    it('a user in two clinics sees only the membership of the tenant in context', async () => {
      const mine = await asA(() =>
        db.tenantMembership.findMany({ where: { userId: fx.m.userId } }),
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]?.tenantId).toBe(fx.a.tenantId);
    });
  });

  describe('audit log through the tenant client (append-only)', () => {
    it('create is stamped with the tenant; reads are scoped', async () => {
      const row = await asA(() =>
        db.auditLog.create({
          data: { action: 'branch.created', entityType: 'branch' },
        }),
      );
      expect(row.tenantId).toBe(fx.a.tenantId);
      await owner.auditLog.create({
        data: { action: 'platform.event', entityType: 'platform' },
      });
      const visible = await asA(() => db.auditLog.findMany());
      expect(visible.map((r) => r.action)).toEqual(['branch.created']);
    });

    it('create with a different tenant throws; update/delete are not allowed', async () => {
      await expect(
        asA(() =>
          loose(
            db.auditLog,
            'create',
          )({
            data: { action: 'x', entityType: 'x', tenantId: fx.b.tenantId },
          }),
        ),
      ).rejects.toThrow(/tenant/i);
      const row = await asA(() =>
        db.auditLog.create({ data: { action: 'x', entityType: 'x' } }),
      );
      await expect(
        asA(() =>
          db.auditLog.update({ where: { id: row.id }, data: { action: 'y' } }),
        ),
      ).rejects.toThrow(/append-only/i);
      await expect(asA(() => db.auditLog.deleteMany())).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  describe('concurrency', () => {
    it('interleaved contexts for two tenants never mix', async () => {
      const run = (tenantId: string, delay: number) =>
        RequestContext.run({ tenantId }, async () => {
          await new Promise((r) => setTimeout(r, delay));
          return db.branch.findMany();
        });
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 === 0
            ? run(fx.a.tenantId, 10 - (i % 5)).then((rows) => ({
                rows,
                tenant: fx.a.tenantId,
              }))
            : run(fx.b.tenantId, i % 7).then((rows) => ({
                rows,
                tenant: fx.b.tenantId,
              })),
        ),
      );
      for (const { rows, tenant } of results) {
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.tenantId === tenant)).toBe(true);
      }
    });
  });
});
