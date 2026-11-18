import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { executionContextFor } from '../../../test/support/execution-context.js';
import { RequestContext } from '../../context/request-context.js';
import { Public } from '../decorators/public.decorator.js';
import { RequirePermissions } from '../decorators/require-permissions.decorator.js';
import { TenantNotRequired } from '../decorators/tenant-not-required.decorator.js';
import { DomainError } from '../errors/domain-error.js';
import { PermissionsGuard } from './permissions.guard.js';

@Controller()
class Sample {
  @Public() @Get() open() {}
  @TenantNotRequired() @Get() noTenant() {}
  @Get() undecorated() {}
  @RequirePermissions('tenant.read') @Get() one() {}
  @RequirePermissions('tenant.read', 'branches.manage') @Get() two() {}
}

describe('PermissionsGuard', () => {
  const context = new RequestContext();
  const guard = new PermissionsGuard(new Reflector(), context);
  const run = (method: keyof Sample, permissions: string[]) =>
    RequestContext.run({ permissions: new Set(permissions) }, () =>
      guard.canActivate(executionContextFor(Sample, method)),
    );

  it.each(['open', 'noTenant'] as const)('skips %s', (method) => {
    expect(run(method, [])).toBe(true);
  });

  it('denies an undecorated tenant-scoped route (deny by default)', () => {
    expect(() => run('undecorated', ['tenant.read'])).toThrow(DomainError);
  });

  it('allows when the single required permission is held', () => {
    expect(run('one', ['tenant.read'])).toBe(true);
  });

  it('requires EVERY listed permission', () => {
    expect(run('two', ['tenant.read', 'branches.manage'])).toBe(true);
    expect(() => run('two', ['tenant.read'])).toThrow(DomainError);
  });

  it('throws FORBIDDEN', () => {
    try {
      run('one', []);
      expect.unreachable();
    } catch (error) {
      expect((error as DomainError).code).toBe('FORBIDDEN');
    }
  });
});
