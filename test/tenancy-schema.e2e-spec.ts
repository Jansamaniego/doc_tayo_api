import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PERMISSION_KEYS } from '../src/modules/access-control/catalog.js';
import {
  createAppClient,
  createOwnerClient,
  raw,
  resetTenancyData,
} from './support/db.js';

describe('tenancy schema (real PostgreSQL)', () => {
  let owner: PrismaClient;
  let app: PrismaClient;

  beforeAll(() => {
    owner = createOwnerClient();
    app = createAppClient();
  });
  afterAll(async () => {
    await owner.$disconnect();
    await app.$disconnect();
  });
  beforeEach(() => resetTenancyData(owner));

  describe('composite foreign keys reject cross-tenant references', () => {
    it('membership_roles: Clinic A membership + Clinic B role', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const b = await raw.tenant(owner, 'clinic-b');
      const user = await raw.user(owner, 'm@example.com');
      const membershipA = await raw.membership(owner, a, user);
      const roleB = await raw.role(owner, b, 'owner');

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO membership_roles (id, tenant_id, membership_id, role_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`,
          a,
          membershipA,
          roleB,
        ),
      ).rejects.toThrow(/foreign key|23503/i);
    });

    it('membership_roles: same-tenant link succeeds (control)', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const user = await raw.user(owner, 'm@example.com');
      const membershipA = await raw.membership(owner, a, user);
      const roleA = await raw.role(owner, a, 'owner');

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO membership_roles (id, tenant_id, membership_id, role_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`,
          a,
          membershipA,
          roleA,
        ),
      ).resolves.toBe(1);
    });

    it('role_permissions: tenant A row pointing at a Clinic B role', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const b = await raw.tenant(owner, 'clinic-b');
      const roleB = await raw.role(owner, b, 'owner');
      const [permission] = await owner.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM permissions LIMIT 1`,
      );

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO role_permissions (id, tenant_id, role_id, permission_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid)`,
          a,
          roleB,
          permission!.id,
        ),
      ).rejects.toThrow(/foreign key|23503/i);
    });

    it('audit_logs: actor membership from another tenant', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const b = await raw.tenant(owner, 'clinic-b');
      const user = await raw.user(owner, 'm@example.com');
      const membershipB = await raw.membership(owner, b, user);

      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO audit_logs (id, tenant_id, actor_membership_id, action, entity_type)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'x.y', 'x')`,
          a,
          membershipB,
        ),
      ).rejects.toThrow(/foreign key|23503/i);
    });
  });

  describe('unique constraints', () => {
    it('duplicate branch name within a tenant, allowed across tenants', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const b = await raw.tenant(owner, 'clinic-b');
      await raw.branch(owner, a, 'Main');
      await expect(raw.branch(owner, a, 'Main')).rejects.toThrow(
        /unique|23505/i,
      );
      await expect(raw.branch(owner, b, 'Main')).resolves.toBeTruthy();
    });

    it('duplicate membership (tenant, user)', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const user = await raw.user(owner, 'm@example.com');
      await raw.membership(owner, a, user);
      await expect(raw.membership(owner, a, user)).rejects.toThrow(
        /unique|23505/i,
      );
    });

    it('duplicate role key within a tenant', async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      await raw.role(owner, a, 'owner');
      await expect(raw.role(owner, a, 'owner')).rejects.toThrow(
        /unique|23505/i,
      );
    });

    it('duplicate tenant slug and user email', async () => {
      await raw.tenant(owner, 'clinic-a');
      await expect(raw.tenant(owner, 'clinic-a')).rejects.toThrow(
        /unique|23505/i,
      );
      await raw.user(owner, 'm@example.com');
      await expect(raw.user(owner, 'm@example.com')).rejects.toThrow(
        /unique|23505/i,
      );
    });
  });

  describe('append-only audit log (runtime role)', () => {
    const insertAudit = (client: PrismaClient) =>
      client.$executeRawUnsafe(
        `INSERT INTO audit_logs (id, action, entity_type) VALUES (gen_random_uuid(), 'tenant.created', 'tenant')`,
      );

    it('allows INSERT', async () => {
      await expect(insertAudit(app)).resolves.toBe(1);
    });

    it('denies UPDATE, DELETE and TRUNCATE', async () => {
      await insertAudit(app);
      await expect(
        app.$executeRawUnsafe(`UPDATE audit_logs SET action = 'tampered'`),
      ).rejects.toThrow(/permission denied|42501/i);
      await expect(
        app.$executeRawUnsafe(`DELETE FROM audit_logs`),
      ).rejects.toThrow(/permission denied|42501/i);
      await expect(
        app.$executeRawUnsafe(`TRUNCATE audit_logs`),
      ).rejects.toThrow(/permission denied|42501/i);
    });
  });

  describe('permission catalog', () => {
    it('the permissions table equals the code catalog', async () => {
      const rows = await owner.$queryRawUnsafe<{ key: string }[]>(
        `SELECT key FROM permissions ORDER BY key`,
      );
      expect(rows.map((r) => r.key)).toEqual([...PERMISSION_KEYS].sort());
    });
  });
});
