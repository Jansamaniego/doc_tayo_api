import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';

/**
 * Raw database clients for tests that must act outside the application:
 * the owner role (migrations, fixtures, deliberately invalid inserts) and the
 * runtime role (exactly the privileges the running API has).
 */
function makeClient(url: string | undefined): PrismaClient {
  if (!url) throw new Error('Database URL is not set for the test client.');
  const database = new URL(url).pathname.replace(/^\//, '');
  if (!database.endsWith('_test')) {
    throw new Error(`Refusing to connect to non-test database "${database}".`);
  }
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url, max: 2 }),
  });
}

export const createOwnerClient = () =>
  makeClient(process.env.DATABASE_MIGRATION_URL);
export const createAppClient = () => makeClient(process.env.DATABASE_URL);

const TENANCY_TABLES = [
  'audit_logs',
  'refresh_tokens',
  'sessions',
  'user_tokens',
  'invitations',
  'membership_roles',
  'role_permissions',
  'roles',
  'tenant_memberships',
  'branches',
  'tenants',
  'users',
];

/** Empties every tenancy table (not the migration-managed `permissions`). */
export async function resetTenancyData(owner: PrismaClient): Promise<void> {
  await owner.$executeRawUnsafe(
    `TRUNCATE ${TENANCY_TABLES.join(', ')} RESTART IDENTITY CASCADE`,
  );
  // Queued mail must not leak from one test into the next one's delivery run.
  await owner.$executeRawUnsafe(
    `TRUNCATE nest_outbox.messages, nest_outbox.dead_letters, nest_outbox.inbox`,
  );
}

type Row = { id: string };

/** Raw fixture inserts (owner role) that return the new row id. */
export const raw = {
  async user(owner: PrismaClient, email: string): Promise<string> {
    const rows = await owner.$queryRawUnsafe<Row[]>(
      `INSERT INTO users (id, email, full_name) VALUES (gen_random_uuid(), $1, 'Test User') RETURNING id`,
      email,
    );
    return rows[0]!.id;
  },
  async tenant(owner: PrismaClient, slug: string): Promise<string> {
    const rows = await owner.$queryRawUnsafe<Row[]>(
      `INSERT INTO tenants (id, name, slug) VALUES (gen_random_uuid(), $1, $1) RETURNING id`,
      slug,
    );
    return rows[0]!.id;
  },
  async branch(
    owner: PrismaClient,
    tenantId: string,
    name: string,
  ): Promise<string> {
    const rows = await owner.$queryRawUnsafe<Row[]>(
      `INSERT INTO branches (id, tenant_id, name) VALUES (gen_random_uuid(), $1::uuid, $2) RETURNING id`,
      tenantId,
      name,
    );
    return rows[0]!.id;
  },
  async membership(
    owner: PrismaClient,
    tenantId: string,
    userId: string,
  ): Promise<string> {
    const rows = await owner.$queryRawUnsafe<Row[]>(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id) VALUES (gen_random_uuid(), $1::uuid, $2::uuid) RETURNING id`,
      tenantId,
      userId,
    );
    return rows[0]!.id;
  },
  async role(
    owner: PrismaClient,
    tenantId: string,
    key: string,
  ): Promise<string> {
    const rows = await owner.$queryRawUnsafe<Row[]>(
      `INSERT INTO roles (id, tenant_id, key, name) VALUES (gen_random_uuid(), $1::uuid, $2, $2) RETURNING id`,
      tenantId,
      key,
    );
    return rows[0]!.id;
  },
};
