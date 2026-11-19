import { createHash, randomBytes } from 'node:crypto';
import { PERMISSION_KEYS } from '../src/modules/access-control/catalog.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createAppClient,
  createOwnerClient,
  raw,
  resetTenancyData,
} from './support/db.js';

const hash = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const FK = /foreign key|23503/i;
const UNIQUE = /unique|23505/i;

describe('authentication schema (real PostgreSQL)', () => {
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

  const session = async (userId: string): Promise<string> => {
    const rows = await owner.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO sessions (id, user_id, principal_type, last_used_at, idle_expires_at, absolute_expires_at)
       VALUES (gen_random_uuid(), $1::uuid, 'staff', now(), now() + interval '1 day', now() + interval '2 day')
       RETURNING id`,
      userId,
    );
    return rows[0]!.id;
  };
  const refreshToken = (sessionId: string, tokenHash: string) =>
    owner.$executeRawUnsafe(
      `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1::uuid, $2, now() + interval '1 day')`,
      sessionId,
      tokenHash,
    );
  const userToken = (userId: string, tokenHash: string) =>
    owner.$executeRawUnsafe(
      `INSERT INTO user_tokens (id, user_id, type, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1::uuid, 'password_reset', $2, now() + interval '1 hour')`,
      userId,
      tokenHash,
    );
  const invitation = (
    tenantId: string,
    roleId: string,
    invitedBy: string,
    email: string,
    tokenHash = hash(),
    tail = '',
  ) =>
    owner.$executeRawUnsafe(
      `INSERT INTO invitations (id, tenant_id, email, role_id, invited_by_membership_id, token_hash, expires_at ${tail ? ', ' + tail.split('=')[0] : ''})
       VALUES (gen_random_uuid(), $1::uuid, $2, $3::uuid, $4::uuid, $5, now() + interval '7 days' ${tail ? ', ' + tail.split('=')[1] : ''})`,
      tenantId,
      email,
      roleId,
      invitedBy,
      tokenHash,
    );

  describe('users credentials', () => {
    it('password_hash is omitted from default Prisma results but selectable explicitly', async () => {
      await owner.$executeRawUnsafe(
        `INSERT INTO users (id, email, full_name, password_hash) VALUES (gen_random_uuid(), 'omit@example.com', 'Omit', '$argon2id$x')`,
      );
      const nest = await createTestApp();
      try {
        const prisma = nest.get(PrismaService);
        const plain = await prisma.user.findUniqueOrThrow({
          where: { email: 'omit@example.com' },
        });
        expect('passwordHash' in plain).toBe(false);
        const withHash = await prisma.user.findUniqueOrThrow({
          where: { email: 'omit@example.com' },
          select: { passwordHash: true },
        });
        expect(withHash.passwordHash).toBe('$argon2id$x');
      } finally {
        await nest.close();
      }
    });

    it('credential columns default sensibly', async () => {
      const id = await raw.user(owner, 'defaults@example.com');
      const [row] = await owner.$queryRawUnsafe<
        {
          password_hash: string | null;
          email_verified_at: Date | null;
          password_changed_at: Date | null;
          failed_login_count: number;
          locked_until: Date | null;
        }[]
      >(`SELECT * FROM users WHERE id = $1::uuid`, id);
      expect(row).toMatchObject({
        password_hash: null,
        email_verified_at: null,
        password_changed_at: null,
        failed_login_count: 0,
        locked_until: null,
      });
    });
  });

  describe('sessions, refresh tokens, user tokens', () => {
    it('refresh_tokens.token_hash is unique', async () => {
      const user = await raw.user(owner, 'u@example.com');
      const s = await session(user);
      const h = hash();
      await refreshToken(s, h);
      await expect(refreshToken(s, h)).rejects.toThrow(UNIQUE);
    });

    it('user_tokens.token_hash is unique', async () => {
      const user = await raw.user(owner, 'u@example.com');
      const h = hash();
      await userToken(user, h);
      await expect(userToken(user, h)).rejects.toThrow(UNIQUE);
    });

    it('sessions reject an unknown principal_type and an unknown user', async () => {
      const user = await raw.user(owner, 'u@example.com');
      await expect(
        owner.$executeRawUnsafe(
          `INSERT INTO sessions (id, user_id, principal_type, last_used_at, idle_expires_at, absolute_expires_at)
           VALUES (gen_random_uuid(), $1::uuid, 'robot', now(), now(), now())`,
          user,
        ),
      ).rejects.toThrow();
      await expect(
        session('00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow(FK);
    });

    it('a user with sessions cannot be deleted (Restrict)', async () => {
      const user = await raw.user(owner, 'u@example.com');
      await session(user);
      await expect(
        owner.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, user),
      ).rejects.toThrow(FK);
    });
  });

  describe('invitations (tenant-owned)', () => {
    const setup = async () => {
      const a = await raw.tenant(owner, 'clinic-a');
      const b = await raw.tenant(owner, 'clinic-b');
      const user = await raw.user(owner, 'admin@example.com');
      const membershipA = await raw.membership(owner, a, user);
      const membershipB = await raw.membership(owner, b, user);
      const roleA = await raw.role(owner, a, 'doctor');
      const roleB = await raw.role(owner, b, 'doctor');
      return { a, b, user, membershipA, membershipB, roleA, roleB };
    };

    it('token_hash is unique', async () => {
      const { a, roleA, membershipA } = await setup();
      const h = hash();
      await invitation(a, roleA, membershipA, 'x@example.com', h);
      await expect(
        invitation(a, roleA, membershipA, 'y@example.com', h),
      ).rejects.toThrow(UNIQUE);
    });

    it('allows one open invitation per email per tenant; accepted or revoked ones free the slot', async () => {
      const { a, b, roleA, roleB, membershipA, membershipB } = await setup();
      await invitation(a, roleA, membershipA, 'x@example.com');
      await expect(
        invitation(a, roleA, membershipA, 'x@example.com'),
      ).rejects.toThrow(UNIQUE);
      // Another tenant is independent.
      await expect(
        invitation(b, roleB, membershipB, 'x@example.com'),
      ).resolves.toBe(1);
      // Revoke the open one: a new open invitation is allowed.
      await owner.$executeRawUnsafe(
        `UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1::uuid AND email = 'x@example.com'`,
        a,
      );
      await expect(
        invitation(a, roleA, membershipA, 'x@example.com'),
      ).resolves.toBe(1);
      // Accept the new one: another open invitation is allowed again.
      await owner.$executeRawUnsafe(
        `UPDATE invitations SET accepted_at = now() WHERE tenant_id = $1::uuid AND email = 'x@example.com' AND revoked_at IS NULL`,
        a,
      );
      await expect(
        invitation(a, roleA, membershipA, 'x@example.com'),
      ).resolves.toBe(1);
    });

    it('rejects a role from another tenant (composite FK)', async () => {
      const { a, roleB, membershipA } = await setup();
      await expect(
        invitation(a, roleB, membershipA, 'x@example.com'),
      ).rejects.toThrow(FK);
    });

    it('rejects an inviter membership from another tenant (composite FK)', async () => {
      const { a, roleA, membershipB } = await setup();
      await expect(
        invitation(a, roleA, membershipB, 'x@example.com'),
      ).rejects.toThrow(FK);
    });
  });

  describe('permissions catalog', () => {
    it('the permissions table equals the code catalog (including members.invite)', async () => {
      const rows = await owner.$queryRawUnsafe<{ key: string }[]>(
        `SELECT key FROM permissions ORDER BY key`,
      );
      expect(rows.map((r) => r.key)).toEqual([...PERMISSION_KEYS].sort());
      expect(PERMISSION_KEYS).toContain('members.invite');
    });
  });

  describe('outbox schema (created by our migration, used by the runtime role)', () => {
    it('exists with its tables', async () => {
      const rows = await owner.$queryRawUnsafe<{ table_name: string }[]>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'nest_outbox' ORDER BY table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual([
        'dead_letters',
        'inbox',
        'messages',
        'migrations',
      ]);
    });

    it('the runtime role can read and write messages (and has no DDL)', async () => {
      await expect(
        app.$executeRawUnsafe(
          `INSERT INTO nest_outbox.messages (id, topic, payload, headers, created_at, available_at)
           VALUES ('m-' || gen_random_uuid(), 'schema.test', '{}', '{}', 1, 1)`,
        ),
      ).resolves.toBe(1);
      await expect(
        app.$queryRawUnsafe(`SELECT count(*) FROM nest_outbox.messages`),
      ).resolves.toBeTruthy();
      await app.$executeRawUnsafe(
        `DELETE FROM nest_outbox.messages WHERE topic = 'schema.test'`,
      );
      await expect(
        app.$executeRawUnsafe(`CREATE TABLE nest_outbox.nope (id int)`),
      ).rejects.toThrow(/permission denied|42501/i);
    });
  });
});
