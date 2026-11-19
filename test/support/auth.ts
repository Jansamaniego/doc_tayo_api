import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { PasswordHasher } from '../../src/modules/auth/password-hasher.js';

/** Same cheap parameters as .env.test, so fixtures match what the app verifies. */
const hasher = new PasswordHasher({
  memoryKib: 1024,
  timeCost: 1,
  parallelism: 1,
});

export const TEST_PASSWORD = 'correct horse battery staple';

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** An `active`, email-verified user with a known password (owner role insert). */
export async function createActiveUser(
  owner: PrismaClient,
  email: string,
  options: {
    password?: string;
    fullName?: string;
    status?: 'pending' | 'active' | 'deactivated';
  } = {},
): Promise<TestUser> {
  const password = options.password ?? TEST_PASSWORD;
  const user = await owner.user.create({
    data: {
      email,
      fullName: options.fullName ?? email,
      status: options.status ?? 'active',
      passwordHash: await hasher.hash(password),
      emailVerifiedAt: new Date(),
      passwordChangedAt: new Date(),
    },
    select: { id: true },
  });
  return { id: user.id, email, password };
}

/** Gives existing (fixture) users a known password and verified email. */
export async function setPasswords(
  owner: PrismaClient,
  emails: string[],
  password = TEST_PASSWORD,
): Promise<void> {
  const passwordHash = await hasher.hash(password);
  await owner.user.updateMany({
    where: { email: { in: emails } },
    data: { passwordHash, emailVerifiedAt: new Date(), status: 'active' },
  });
}

/** `Set-Cookie` header values of a supertest response. */
export function setCookies(res: {
  headers: Record<string, unknown>;
}): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === 'string'
      ? [raw]
      : [];
}

/** The `dt_refresh` cookie value (or undefined) from a response. */
export function refreshCookie(res: {
  headers: Record<string, unknown>;
}): string | undefined {
  const header = setCookies(res).find((c) => c.startsWith('dt_refresh='));
  return header?.split(';')[0]?.slice('dt_refresh='.length);
}

/** The allowed origin from .env.test (CORS_ALLOWED_ORIGINS). */
export const ALLOWED_ORIGIN = 'http://localhost:5173';

import { ROLE_TEMPLATES } from '../../src/modules/access-control/catalog.js';

/**
 * Adds `userId` to a NEW clinic (tenant, default branch, system roles with
 * template permissions) with the given role keys. Returns the clinic ids.
 */
export async function seedMembership(
  owner: PrismaClient,
  userId: string,
  slug: string,
  roles: string[],
  options: {
    tenantStatus?: 'active' | 'suspended' | 'deactivated';
    membershipStatus?: 'invited' | 'active' | 'suspended' | 'removed';
  } = {},
): Promise<{
  tenantId: string;
  membershipId: string;
  roleIds: Record<string, string>;
}> {
  const tenant = await owner.tenant.create({
    data: { name: slug, slug, status: options.tenantStatus ?? 'active' },
  });
  const permissions = await owner.permission.findMany();
  const permissionId = new Map(permissions.map((p) => [p.key, p.id]));
  const roleIds: Record<string, string> = {};
  for (const template of ROLE_TEMPLATES) {
    const role = await owner.role.create({
      data: {
        tenantId: tenant.id,
        key: template.key,
        name: template.name,
        isSystem: true,
      },
    });
    roleIds[template.key] = role.id;
    await owner.rolePermission.createMany({
      data: template.permissions.map((key) => ({
        tenantId: tenant.id,
        roleId: role.id,
        permissionId: permissionId.get(key)!,
      })),
    });
  }
  const membership = await owner.tenantMembership.create({
    data: {
      tenantId: tenant.id,
      userId,
      status: options.membershipStatus ?? 'active',
    },
  });
  for (const key of roles) {
    await owner.membershipRole.create({
      data: {
        tenantId: tenant.id,
        membershipId: membership.id,
        roleId: roleIds[key]!,
      },
    });
  }
  return { tenantId: tenant.id, membershipId: membership.id, roleIds };
}
