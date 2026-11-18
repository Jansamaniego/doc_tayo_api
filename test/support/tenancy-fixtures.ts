import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { ROLE_TEMPLATES } from '../../src/modules/access-control/catalog.js';

export interface SeedMember {
  email: string;
  /** Role keys from ROLE_TEMPLATES. */
  roles: string[];
  membershipStatus?: 'invited' | 'active' | 'suspended' | 'removed';
  userStatus?: 'pending' | 'active' | 'deactivated';
  /** Reuse an existing user (same human in several clinics). */
  userId?: string;
}

export interface SeededMember {
  userId: string;
  membershipId: string;
}

export interface SeededClinic {
  tenantId: string;
  branchId: string;
  roleIds: Record<string, string>;
  members: Record<string, SeededMember>;
}

/**
 * Seeds one clinic directly (owner role, no onboarding service): tenant, a
 * default branch, the five system roles with their template permissions, and
 * the requested members. Keys of `members` in the result are the emails.
 */
export async function seedClinic(
  owner: PrismaClient,
  slug: string,
  members: SeedMember[],
  options: { status?: 'active' | 'suspended' | 'deactivated' } = {},
): Promise<SeededClinic> {
  const tenant = await owner.tenant.create({
    data: { name: slug, slug, status: options.status ?? 'active' },
  });
  const branch = await owner.branch.create({
    data: { tenantId: tenant.id, name: 'Main' },
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
    for (const key of template.permissions) {
      await owner.rolePermission.create({
        data: {
          tenantId: tenant.id,
          roleId: role.id,
          permissionId: permissionId.get(key)!,
        },
      });
    }
  }

  const seeded: Record<string, SeededMember> = {};
  for (const member of members) {
    const userId =
      member.userId ??
      (
        await owner.user.create({
          data: {
            email: member.email,
            fullName: member.email,
            status: member.userStatus ?? 'active',
          },
        })
      ).id;
    const membership = await owner.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId,
        status: member.membershipStatus ?? 'active',
      },
    });
    for (const roleKey of member.roles) {
      await owner.membershipRole.create({
        data: {
          tenantId: tenant.id,
          membershipId: membership.id,
          roleId: roleIds[roleKey]!,
        },
      });
    }
    seeded[member.email] = { userId, membershipId: membership.id };
  }
  return { tenantId: tenant.id, branchId: branch.id, roleIds, members: seeded };
}

export interface StandardFixture {
  a: SeededClinic;
  b: SeededClinic;
  /** User M: owner in Clinic A, receptionist in Clinic B. */
  m: { userId: string; emailA: string };
}

/** Clinic A, Clinic B and user M (the plan's isolation fixture, §11.6). */
export async function seedStandardFixture(
  owner: PrismaClient,
): Promise<StandardFixture> {
  const user = await owner.user.create({
    data: { email: 'm@example.com', fullName: 'M', status: 'active' },
  });
  const a = await seedClinic(owner, 'clinic-a', [
    { email: 'm@example.com', roles: ['owner'], userId: user.id },
    { email: 'a-owner@example.com', roles: ['owner'] },
    { email: 'a-recep@example.com', roles: ['receptionist'] },
  ]);
  const b = await seedClinic(owner, 'clinic-b', [
    { email: 'm@example.com', roles: ['receptionist'], userId: user.id },
    { email: 'b-owner@example.com', roles: ['owner'] },
    { email: 'b-recep@example.com', roles: ['receptionist'] },
  ]);
  return { a, b, m: { userId: user.id, emailA: 'm@example.com' } };
}
