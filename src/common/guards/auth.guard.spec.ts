import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import { executionContextFor } from '../../../test/support/execution-context.js';
import { RequestContext } from '../../context/request-context.js';
import { DomainError } from '../errors/domain-error.js';
import { Public } from '../decorators/public.decorator.js';
import { AuthGuard } from './auth.guard.js';

@Controller()
class Sample {
  @Get() secured() {}
  @Public() @Get() open() {}
}

@Public()
@Controller()
class PublicClass {
  @Get() any() {}
}

describe('AuthGuard', () => {
  const authenticate = vi.fn();
  const context = new RequestContext();
  const guard = new AuthGuard(new Reflector(), { authenticate }, context);

  beforeEach(() => authenticate.mockReset());

  it('skips @Public() handlers without calling the authenticator', async () => {
    await expect(
      guard.canActivate(executionContextFor(Sample, 'open')),
    ).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('skips handlers of a @Public() class', async () => {
    await expect(
      guard.canActivate(executionContextFor(PublicClass, 'any')),
    ).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('throws UNAUTHENTICATED when the authenticator returns null', async () => {
    authenticate.mockResolvedValue(null);
    const error = await RequestContext.run({}, () =>
      guard.canActivate(executionContextFor(Sample, 'secured')),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('UNAUTHENTICATED');
  });

  it('stores the user and requested tenant on success', async () => {
    authenticate.mockResolvedValue({ userId: 'u1', activeTenantId: 't1' });
    await RequestContext.run({}, async () => {
      await expect(
        guard.canActivate(executionContextFor(Sample, 'secured')),
      ).resolves.toBe(true);
      expect(context.requireUser()).toBe('u1');
      expect(context.activeTenantId).toBe('t1');
    });
  });
});
