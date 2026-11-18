import { vi } from 'vitest';
import { RequestContext } from '../../context/request-context.js';
import { AuditService, changedFieldNames } from './audit.service.js';

const UUID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('changedFieldNames', () => {
  it('returns only the names of fields whose value differs, sorted', () => {
    expect(
      changedFieldNames(
        { name: 'A', timezone: 'Asia/Manila', city: null },
        { name: 'B', timezone: 'Asia/Manila', city: 'Cebu' },
      ),
    ).toEqual(['city', 'name']);
  });

  it('ignores undefined (not provided) fields and handles dates', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(
      changedFieldNames(
        { name: 'A', joinedAt: d },
        { name: undefined, joinedAt: new Date(d) },
      ),
    ).toEqual([]);
  });

  it('never returns values', () => {
    const names = changedFieldNames({ secret: 'x' }, { secret: 'y' });
    expect(JSON.stringify(names)).not.toMatch(/[xy]"/);
  });
});

describe('AuditService.record', () => {
  const context = new RequestContext();
  const service = new AuditService(context);
  const create = vi.fn().mockResolvedValue({});
  const db = { auditLog: { create } };

  beforeEach(() => create.mockClear());

  it('fills actor, tenant, request id and ip from the request context', async () => {
    await RequestContext.run(
      { requestId: UUID, ip: '203.0.113.7' },
      async () => {
        context.set({ userId: 'u1', tenantId: 't1', membershipId: 'm1' });
        await service.record(db, {
          action: 'branch.created',
          entityType: 'branch',
          entityId: UUID,
          changedFields: ['name'],
        });
      },
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toEqual({
      data: {
        tenantId: 't1',
        actorUserId: 'u1',
        actorMembershipId: 'm1',
        action: 'branch.created',
        entityType: 'branch',
        entityId: UUID,
        changedFields: ['name'],
        requestId: UUID,
        ip: '203.0.113.7',
      },
    });
  });

  it('explicit entry values win (platform / onboarding events)', async () => {
    await service.record(db, {
      action: 'tenant.created',
      entityType: 'tenant',
      tenantId: 'tX',
      actorUserId: 'uX',
    });
    const data = create.mock.calls[0]?.[0].data;
    expect(data).toMatchObject({
      tenantId: 'tX',
      actorUserId: 'uX',
      changedFields: [],
    });
    expect(data.requestId).toBeNull();
    expect(data.ip).toBeNull();
  });

  it('stores null for a request id that is not a UUID and for a non-IP address', async () => {
    await RequestContext.run(
      { requestId: 'client-made-id', ip: 'garbage' },
      () => service.record(db, { action: 'x.y', entityType: 'x' }),
    );
    const data = create.mock.calls[0]?.[0].data;
    expect(data.requestId).toBeNull();
    expect(data.ip).toBeNull();
  });

  it('accepts IPv6-mapped addresses', async () => {
    await RequestContext.run({ ip: '::ffff:127.0.0.1' }, () =>
      service.record(db, { action: 'x.y', entityType: 'x' }),
    );
    expect(create.mock.calls[0]?.[0].data.ip).toBe('::ffff:127.0.0.1');
  });
});
