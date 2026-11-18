import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { vi } from 'vitest';
import { DomainError } from '../src/common/errors/domain-error.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  PERMISSION_KEYS,
  ROLE_TEMPLATES,
} from '../src/modules/access-control/catalog.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { TenantLifecycleService } from '../src/modules/tenants/tenant-lifecycle.service.js';
import {
  type OnboardTenantInput,
  TenantOnboardingService,
} from '../src/modules/tenants/tenant-onboarding.service.js';
import { createTestApp } from './setup/create-test-app.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { bearer } from './support/test-authenticator.js';

const input = (over: Partial<OnboardTenantInput> = {}): OnboardTenantInput => ({
  name: 'Santos Clinic',
  slug: 'santos-clinic',
  ownerEmail: 'dr.santos@example.com',
  ownerFullName: 'Dr. Santos',
  ...over,
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError
      ? error.code
      : `NOT_DOMAIN:${String(error)}`;
  }
  return undefined;
}

describe('Tenant onboarding and lifecycle (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let onboarding: TenantOnboardingService;
  let lifecycle: TenantLifecycleService;
  let audit: AuditService;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp();
    onboarding = app.get(TenantOnboardingService);
    lifecycle = app.get(TenantLifecycleService);
    audit = app.get(AuditService);
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetTenancyData(owner);
  });

  const counts = async () => ({
    tenants: await owner.tenant.count(),
    users: await owner.user.count(),
    branches: await owner.branch.count(),
    roles: await owner.role.count(),
    rolePermissions: await owner.rolePermission.count(),
    memberships: await owner.tenantMembership.count(),
    membershipRoles: await owner.membershipRole.count(),
    audit: await owner.auditLog.count(),
  });
  const EMPTY = {
    tenants: 0,
    users: 0,
    branches: 0,
    roles: 0,
    rolePermissions: 0,
    memberships: 0,
    membershipRoles: 0,
    audit: 0,
  };

  describe('onboard', () => {
    it('creates tenant, default branch, five system roles, owner membership and one audit row', async () => {
      const actor = await owner.user.create({
        data: {
          email: 'platform@example.com',
          fullName: 'Platform',
          status: 'active',
        },
      });
      const result = await onboarding.onboard(input(), { userId: actor.id });

      const tenant = await owner.tenant.findUniqueOrThrow({
        where: { id: result.tenantId },
      });
      expect(tenant).toMatchObject({
        name: 'Santos Clinic',
        slug: 'santos-clinic',
        status: 'active',
        timezone: 'Asia/Manila',
      });

      const branches = await owner.branch.findMany({
        where: { tenantId: tenant.id },
      });
      expect(branches.map((b) => b.name)).toEqual(['Main']);

      const roles = await owner.role.findMany({
        where: { tenantId: tenant.id },
        include: { permissions: { include: { permission: true } } },
      });
      expect(roles.map((r) => r.key).sort()).toEqual(
        ROLE_TEMPLATES.map((t) => t.key).sort(),
      );
      expect(roles.every((r) => r.isSystem)).toBe(true);
      for (const template of ROLE_TEMPLATES) {
        const role = roles.find((r) => r.key === template.key)!;
        expect(role.permissions.map((p) => p.permission.key).sort()).toEqual(
          [...template.permissions].sort(),
        );
      }
      expect(
        roles
          .find((r) => r.key === 'owner')!
          .permissions.map((p) => p.permission.key)
          .sort(),
      ).toEqual([...PERMISSION_KEYS].sort());

      const membership = await owner.tenantMembership.findUniqueOrThrow({
        where: { id: result.ownerMembershipId },
        include: { roles: { include: { role: true } }, user: true },
      });
      expect(membership).toMatchObject({
        tenantId: tenant.id,
        status: 'active',
      });
      expect(membership.joinedAt).not.toBeNull();
      expect(membership.roles.map((r) => r.role.key)).toEqual(['owner']);
      expect(membership.user).toMatchObject({
        email: 'dr.santos@example.com',
        fullName: 'Dr. Santos',
        status: 'pending',
      });

      const logs = await owner.auditLog.findMany();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        action: 'tenant.created',
        entityType: 'tenant',
        entityId: tenant.id,
        tenantId: tenant.id,
        actorUserId: actor.id,
        actorMembershipId: null,
      });
    });

    it('honors timezone and default branch name; defaults otherwise', async () => {
      const result = await onboarding.onboard(
        input({ timezone: 'Asia/Tokyo', defaultBranchName: 'Makati' }),
        { userId: null },
      );
      const tenant = await owner.tenant.findUniqueOrThrow({
        where: { id: result.tenantId },
      });
      expect(tenant.timezone).toBe('Asia/Tokyo');
      expect((await owner.branch.findFirstOrThrow()).name).toBe('Makati');
    });

    it('normalizes the owner email (case, whitespace)', async () => {
      await onboarding.onboard(
        input({ ownerEmail: '  Dr.Santos@Example.COM ' }),
        { userId: null },
      );
      expect((await owner.user.findFirstOrThrow()).email).toBe(
        'dr.santos@example.com',
      );
    });

    it('reuses an existing user (same human, second clinic) without duplicating or altering it', async () => {
      const existing = await owner.user.create({
        data: {
          email: 'dr.santos@example.com',
          fullName: 'Original Name',
          status: 'active',
        },
      });
      await onboarding.onboard(input(), { userId: null });
      await onboarding.onboard(
        input({
          slug: 'santos-two',
          name: 'Santos Two',
          ownerEmail: 'DR.SANTOS@example.com',
          ownerFullName: 'Different',
        }),
        { userId: null },
      );
      expect(await owner.user.count()).toBe(1);
      const user = await owner.user.findUniqueOrThrow({
        where: { id: existing.id },
      });
      expect(user).toMatchObject({
        fullName: 'Original Name',
        status: 'active',
      });
      expect(
        await owner.tenantMembership.count({ where: { userId: existing.id } }),
      ).toBe(2);
    });

    it('duplicate slug -> CONFLICT_UNIQUE and nothing new is persisted (new owner user rolled back)', async () => {
      await onboarding.onboard(input(), { userId: null });
      const before = await counts();
      const code = await codeOf(
        onboarding.onboard(
          input({ name: 'Other', ownerEmail: 'someone.else@example.com' }),
          {
            userId: null,
          },
        ),
      );
      expect(code).toBe('CONFLICT_UNIQUE');
      expect(await counts()).toEqual(before);
    });

    it('a failure at the last step rolls back everything', async () => {
      vi.spyOn(audit, 'record').mockRejectedValueOnce(new Error('boom'));
      await expect(
        onboarding.onboard(input(), { userId: null }),
      ).rejects.toThrow('boom');
      expect(await counts()).toEqual(EMPTY);
    });

    it.each([
      ['name', { name: '   ' }],
      ['name', { name: 'x'.repeat(121) }],
      ['slug', { slug: 'Bad Slug' }],
      ['slug', { slug: 'ab' }],
      ['slug', { slug: '-leading' }],
      ['timezone', { timezone: 'Mars/Olympus' }],
      ['ownerEmail', { ownerEmail: 'not-an-email' }],
      ['ownerFullName', { ownerFullName: '' }],
      ['defaultBranchName', { defaultBranchName: ' ' }],
    ])('rejects invalid %s', async (field, override) => {
      let error: unknown;
      try {
        await onboarding.onboard(input(override), { userId: null });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('VALIDATION_FAILED');
      expect(
        (error as DomainError).options.details?.map((d) => d.field),
      ).toContain(field);
      expect(await counts()).toEqual(EMPTY);
    });
  });

  describe('lifecycle', () => {
    let tenantId: string;
    let ownerUserId: string;
    beforeEach(async () => {
      const result = await onboarding.onboard(input(), { userId: null });
      tenantId = result.tenantId;
      ownerUserId = result.ownerUserId;
      await owner.user.update({
        where: { id: ownerUserId },
        data: { status: 'active' },
      });
      await owner.auditLog.deleteMany();
    });
    const status = async () =>
      (await owner.tenant.findUniqueOrThrow({ where: { id: tenantId } }))
        .status;

    it('active <-> suspended, and any non-deactivated state -> deactivated', async () => {
      await lifecycle.suspend(tenantId, { userId: null });
      expect(await status()).toBe('suspended');
      await lifecycle.reactivate(tenantId, { userId: null });
      expect(await status()).toBe('active');
      await lifecycle.suspend(tenantId, { userId: null });
      await lifecycle.deactivate(tenantId, { userId: null });
      expect(await status()).toBe('deactivated');
    });

    it('each transition is audited with the changed field name only', async () => {
      await lifecycle.suspend(tenantId, { userId: ownerUserId });
      await lifecycle.reactivate(tenantId, { userId: ownerUserId });
      await lifecycle.deactivate(tenantId, { userId: ownerUserId });
      const logs = await owner.auditLog.findMany({
        orderBy: { occurredAt: 'asc' },
      });
      expect(logs.map((l) => l.action)).toEqual([
        'tenant.suspended',
        'tenant.reactivated',
        'tenant.deactivated',
      ]);
      for (const log of logs) {
        expect(log).toMatchObject({
          tenantId,
          entityType: 'tenant',
          entityId: tenantId,
          changedFields: ['status'],
          actorUserId: ownerUserId,
        });
      }
    });

    it('rejects invalid transitions with CONFLICT and writes no audit row', async () => {
      expect(
        await codeOf(lifecycle.reactivate(tenantId, { userId: null })),
      ).toBe('CONFLICT');
      await lifecycle.suspend(tenantId, { userId: null });
      expect(await codeOf(lifecycle.suspend(tenantId, { userId: null }))).toBe(
        'CONFLICT',
      );
      await lifecycle.deactivate(tenantId, { userId: null });
      expect(
        await codeOf(lifecycle.reactivate(tenantId, { userId: null })),
      ).toBe('CONFLICT');
      expect(await codeOf(lifecycle.suspend(tenantId, { userId: null }))).toBe(
        'CONFLICT',
      );
      expect(
        await codeOf(lifecycle.deactivate(tenantId, { userId: null })),
      ).toBe('CONFLICT');
      expect(await owner.auditLog.count()).toBe(2); // suspend + deactivate only
    });

    it('unknown tenant -> NOT_FOUND', async () => {
      expect(
        await codeOf(
          lifecycle.suspend('00000000-0000-4000-8000-000000000000', {
            userId: null,
          }),
        ),
      ).toBe('NOT_FOUND');
    });

    it('is enforced on the NEXT request by the tenant guard', async () => {
      const membership = await owner.tenantMembership.findFirstOrThrow({
        where: { tenantId },
      });
      const auth = bearer(membership.userId, tenantId);
      const get = () =>
        request(app.getHttpServer())
          .get('/api/v1/_tenant/read')
          .set('Authorization', auth);
      await get().expect(200);
      await lifecycle.suspend(tenantId, { userId: null });
      expect((await get().expect(403)).body.error.code).toBe(
        'TENANT_SUSPENDED',
      );
      await lifecycle.reactivate(tenantId, { userId: null });
      await get().expect(200);
      await lifecycle.deactivate(tenantId, { userId: null });
      expect((await get().expect(403)).body.error.code).toBe(
        'TENANT_DEACTIVATED',
      );
    });
  });
});
