import { RequestContext } from './request-context.js';

describe('RequestContext', () => {
  const context = new RequestContext();

  it('has no store outside a request', () => {
    expect(() => context.requireTenant()).toThrow();
    expect(() => context.requireUser()).toThrow();
    expect(context.requestId).toBeUndefined();
    expect(context.permissions.size).toBe(0);
  });

  it('requireTenant throws when the store has no tenant yet', () => {
    RequestContext.run({ requestId: 'r1' }, () => {
      expect(() => context.requireTenant()).toThrow(/tenant/i);
    });
  });

  it('exposes what guards store', () => {
    RequestContext.run({ requestId: 'r1', ip: '10.0.0.1' }, () => {
      context.set({
        userId: 'u1',
        tenantId: 't1',
        membershipId: 'm1',
        permissions: new Set(['tenant.read']),
      });
      expect(context.requireUser()).toBe('u1');
      expect(context.requireTenant()).toBe('t1');
      expect(context.membershipId).toBe('m1');
      expect(context.requestId).toBe('r1');
      expect(context.ip).toBe('10.0.0.1');
      expect(context.permissions.has('tenant.read')).toBe(true);
    });
  });

  it('isolates concurrent contexts across awaits', async () => {
    const run = (tenantId: string, delay: number) =>
      RequestContext.run({}, async () => {
        context.set({ tenantId });
        await new Promise((r) => setTimeout(r, delay));
        return context.requireTenant();
      });
    const results = await Promise.all([
      run('A', 20),
      run('B', 5),
      run('C', 10),
    ]);
    expect(results).toEqual(['A', 'B', 'C']);
  });

  it('set() outside a context is a programming error', () => {
    expect(() => context.set({ tenantId: 't' })).toThrow();
  });
});
