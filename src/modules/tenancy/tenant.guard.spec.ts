import { Controller, Get, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import { executionContextFor } from '../../../test/support/execution-context.js';
import { Public } from '../../common/decorators/public.decorator.js';
import { TenantNotRequired } from '../../common/decorators/tenant-not-required.decorator.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RequestContext } from '../../context/request-context.js';
import { type ResolvedMembership } from './membership-resolver.js';
import { TenantGuard } from './tenant.guard.js';

@Controller()
class Sample {
  @Get() scoped() {}
  @Public() @Get() open() {}
  @TenantNotRequired() @Get() noTenant() {}
}

const ok: ResolvedMembership = {
  membershipId: 'm1',
  membershipStatus: 'active',
  userStatus: 'active',
  tenantStatus: 'active',
  permissions: ['tenant.read'],
};

describe('TenantGuard', () => {
  const resolve = vi.fn();
  const context = new RequestContext();
  const guard = new TenantGuard(new Reflector(), context, { resolve });

  beforeAll(() => Logger.overrideLogger(false)); // keep the denial warnings out of test output
  beforeEach(() => resolve.mockReset());

  const run = (
    method: keyof Sample,
    store = { userId: 'u1', activeTenantId: 't1' as string | null },
  ) =>
    RequestContext.run({ ...store }, () =>
      guard.canActivate(executionContextFor(Sample, method)),
    );
  const codeOf = async (p: Promise<unknown>) =>
    ((await p.catch((e: unknown) => e)) as DomainError).code;

  it.each(['open', 'noTenant'] as const)('skips %s routes', async (method) => {
    await expect(run(method)).resolves.toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('TENANT_NOT_SELECTED when no active tenant', async () => {
    expect(
      await codeOf(run('scoped', { userId: 'u1', activeTenantId: null })),
    ).toBe('TENANT_NOT_SELECTED');
    expect(resolve).not.toHaveBeenCalled();
  });

  it('TENANT_ACCESS_DENIED when there is no membership', async () => {
    resolve.mockResolvedValue(null);
    expect(await codeOf(run('scoped'))).toBe('TENANT_ACCESS_DENIED');
  });

  it.each([
    [{ userStatus: 'deactivated' }, 'TENANT_ACCESS_DENIED'],
    [{ userStatus: 'pending' }, 'TENANT_ACCESS_DENIED'],
    [{ membershipStatus: 'suspended' }, 'TENANT_ACCESS_DENIED'],
    [{ membershipStatus: 'removed' }, 'TENANT_ACCESS_DENIED'],
    [{ membershipStatus: 'invited' }, 'TENANT_ACCESS_DENIED'],
    [{ tenantStatus: 'suspended' }, 'TENANT_SUSPENDED'],
    [{ tenantStatus: 'deactivated' }, 'TENANT_DEACTIVATED'],
    // An inactive membership in a suspended tenant must not reveal the tenant state.
    [
      { membershipStatus: 'removed', tenantStatus: 'suspended' },
      'TENANT_ACCESS_DENIED',
    ],
  ])('rejects %j with %s', async (override, code) => {
    resolve.mockResolvedValue({ ...ok, ...override });
    expect(await codeOf(run('scoped'))).toBe(code);
  });

  it('stores tenant, membership and permissions on success', async () => {
    resolve.mockResolvedValue(ok);
    await RequestContext.run(
      { userId: 'u1', activeTenantId: 't1' },
      async () => {
        await expect(
          guard.canActivate(executionContextFor(Sample, 'scoped')),
        ).resolves.toBe(true);
        expect(context.requireTenant()).toBe('t1');
        expect(context.membershipId).toBe('m1');
        expect(context.permissions.has('tenant.read')).toBe(true);
      },
    );
    expect(resolve).toHaveBeenCalledWith('t1', 'u1');
  });
});
