import type { INestApplicationContext } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { appConfig } from '../config/configuration.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PasswordHasher } from '../modules/auth/password-hasher.js';
import { TenantOnboardingService } from '../modules/tenants/tenant-onboarding.service.js';

/**
 * Fixed development data so a frontend developer can sign in immediately.
 * The password is public and the accounts exist only where this seed was run:
 * it refuses to run in production.
 */
export const DEV_SEED = {
  clinicName: 'Sunrise Clinic',
  clinicSlug: 'sunrise-clinic',
  ownerEmail: 'owner@sunrise.test',
  ownerFullName: 'Dr. Olivia Owner',
  receptionistEmail: 'reception@sunrise.test',
  receptionistFullName: 'Rhea Receptionist',
  secondBranchName: 'Quezon City Annex',
  password: 'dev-password-change-me-123',
} as const;

export interface SeedResult {
  /** False when the clinic already existed (nothing duplicated). */
  created: boolean;
  tenantId: string;
}

export function assertDevelopmentOnly(env: string): void {
  if (env === 'production') {
    throw new Error('The development seed must never run in production.');
  }
}

/**
 * Creates (or completes) the development clinic: an active owner, an active
 * receptionist (a restricted role) and a second branch. Safe to run repeatedly:
 * every step checks before it creates, and the known passwords are re-applied.
 */
export async function seedDev(
  app: INestApplicationContext,
): Promise<SeedResult> {
  assertDevelopmentOnly(
    app.get<ConfigType<typeof appConfig>>(appConfig.KEY).env,
  );
  const prisma = app.get(PrismaService);
  const onboarding = app.get(TenantOnboardingService);
  const passwordHash = await app.get(PasswordHasher).hash(DEV_SEED.password);
  const now = new Date();

  const existing = await prisma.tenant.findUnique({
    where: { slug: DEV_SEED.clinicSlug },
    select: { id: true },
  });
  const onboarded = existing
    ? undefined
    : await onboarding.onboard(
        {
          name: DEV_SEED.clinicName,
          slug: DEV_SEED.clinicSlug,
          ownerEmail: DEV_SEED.ownerEmail,
          ownerFullName: DEV_SEED.ownerFullName,
        },
        { userId: null },
      );
  const tenantId = (existing?.id ?? onboarded?.tenantId)!;

  // The owner is activated directly, so the emailed setup link is not needed.
  const owner = await prisma.user.update({
    where: { email: DEV_SEED.ownerEmail },
    data: {
      status: 'active',
      passwordHash,
      passwordChangedAt: now,
      emailVerifiedAt: now,
    },
    select: { id: true },
  });
  await prisma.userToken.updateMany({
    where: { userId: owner.id, type: 'account_setup', usedAt: null },
    data: { usedAt: now },
  });

  const receptionist = await prisma.user.upsert({
    where: { email: DEV_SEED.receptionistEmail },
    update: { status: 'active', passwordHash, passwordChangedAt: now },
    create: {
      email: DEV_SEED.receptionistEmail,
      fullName: DEV_SEED.receptionistFullName,
      status: 'active',
      passwordHash,
      passwordChangedAt: now,
      emailVerifiedAt: now,
    },
    select: { id: true },
  });
  const membership = await prisma.tenantMembership.findUnique({
    where: { tenantId_userId: { tenantId, userId: receptionist.id } },
    select: { id: true },
  });
  if (!membership) {
    const role = await prisma.role.findUniqueOrThrow({
      where: { tenantId_key: { tenantId, key: 'receptionist' } },
      select: { id: true },
    });
    const created = await prisma.tenantMembership.create({
      data: {
        tenantId,
        userId: receptionist.id,
        status: 'active',
        joinedAt: now,
      },
      select: { id: true },
    });
    await prisma.membershipRole.create({
      data: { tenantId, membershipId: created.id, roleId: role.id },
    });
  }

  const branch = await prisma.branch.findUnique({
    where: { tenantId_name: { tenantId, name: DEV_SEED.secondBranchName } },
    select: { id: true },
  });
  if (!branch) {
    await prisma.branch.create({
      data: { tenantId, name: DEV_SEED.secondBranchName, city: 'Quezon City' },
    });
  }

  return { created: !existing, tenantId };
}
