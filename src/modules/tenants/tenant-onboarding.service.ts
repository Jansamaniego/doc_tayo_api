import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import {
  FIELD_ERROR_CODES,
  type FieldError,
  type FieldErrorCode,
} from '../../common/errors/error-codes.js';
import { normalizeEmail } from '../../common/validation/email.js';
import { isValidTimeZone } from '../../common/validation/timezone.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ROLE_TEMPLATES } from '../access-control/catalog.js';
import { AuditService } from '../audit/audit.service.js';
import {
  ACCOUNT_SETUP_TTL_MS,
  UserTokenService,
} from '../auth/user-token.service.js';
import { MailQueue } from '../mail/mail-queue.service.js';

export interface OnboardTenantInput {
  name: string;
  slug: string;
  timezone?: string;
  ownerEmail: string;
  ownerFullName: string;
  /** Defaults to `Main`. */
  defaultBranchName?: string;
}

/** Who performs the onboarding (a platform admin; null for system/tests). */
export interface PlatformActor {
  userId: string | null;
}

export interface OnboardTenantResult {
  tenantId: string;
  branchId: string;
  ownerUserId: string;
  ownerMembershipId: string;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TIMEZONE = 'Asia/Manila';

function problem(field: string, code: FieldErrorCode): FieldError {
  return { field, code, message: FIELD_ERROR_CODES[code] };
}

function validate(input: OnboardTenantInput): FieldError[] {
  const errors: FieldError[] = [];
  const text = (field: string, value: string | undefined, max: number) => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) errors.push(problem(field, 'REQUIRED'));
    else if (trimmed.length > max) errors.push(problem(field, 'TOO_LONG'));
  };
  text('name', input.name, 120);
  text('ownerFullName', input.ownerFullName, 120);
  if (input.defaultBranchName !== undefined) {
    text('defaultBranchName', input.defaultBranchName, 120);
  }

  const slug = input.slug ?? '';
  if (slug.length < 3 || slug.length > 63) {
    errors.push(problem('slug', slug ? 'OUT_OF_RANGE' : 'REQUIRED'));
  } else if (!SLUG.test(slug)) {
    errors.push(problem('slug', 'INVALID_FORMAT'));
  }

  const email = normalizeEmail(input.ownerEmail ?? '');
  if (!email) errors.push(problem('ownerEmail', 'REQUIRED'));
  else if (email.length > 254 || !EMAIL.test(email)) {
    errors.push(problem('ownerEmail', 'INVALID_FORMAT'));
  }

  if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
    errors.push(problem('timezone', 'INVALID_VALUE'));
  }
  return errors;
}

@Injectable()
export class TenantOnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: UserTokenService,
    private readonly mail: MailQueue,
  ) {}

  /**
   * Creates a clinic in ONE transaction: owner user (found or created),
   * tenant, default branch, the system roles with their template permissions,
   * the owner membership and the audit entry. Any failure rolls back all of it.
   */
  async onboard(
    input: OnboardTenantInput,
    actor: PlatformActor,
  ): Promise<OnboardTenantResult> {
    const details = validate(input);
    if (details.length > 0) {
      throw new DomainError('VALIDATION_FAILED', { details });
    }
    const email = normalizeEmail(input.ownerEmail);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // An existing human keeps their account untouched (global identity).
        const user = await tx.user.upsert({
          where: { email },
          update: {},
          create: {
            email,
            fullName: input.ownerFullName.trim(),
            status: 'pending',
          },
        });

        const tenant = await tx.tenant.create({
          data: {
            name: input.name.trim(),
            slug: input.slug,
            timezone: input.timezone ?? DEFAULT_TIMEZONE,
          },
        });

        const branch = await tx.branch.create({
          data: {
            tenantId: tenant.id,
            name: (input.defaultBranchName ?? 'Main').trim(),
          },
        });

        const keys = [...new Set(ROLE_TEMPLATES.flatMap((t) => t.permissions))];
        const permissions = await tx.permission.findMany({
          where: { key: { in: keys } },
        });
        const permissionId = new Map(permissions.map((p) => [p.key, p.id]));
        const roleIds = new Map<string, string>();
        for (const template of ROLE_TEMPLATES) {
          const role = await tx.role.create({
            data: {
              tenantId: tenant.id,
              key: template.key,
              name: template.name,
              isSystem: true,
            },
          });
          roleIds.set(template.key, role.id);
          await tx.rolePermission.createMany({
            data: template.permissions.map((key) => {
              const id = permissionId.get(key);
              if (!id) {
                // Catalog and permissions table out of sync (a test guards this).
                throw new Error(
                  'A catalog permission is missing from the database.',
                );
              }
              return { tenantId: tenant.id, roleId: role.id, permissionId: id };
            }),
          });
        }

        const membership = await tx.tenantMembership.create({
          data: {
            tenantId: tenant.id,
            userId: user.id,
            status: 'active',
            joinedAt: new Date(),
          },
        });
        await tx.membershipRole.create({
          data: {
            tenantId: tenant.id,
            membershipId: membership.id,
            roleId: roleIds.get('owner')!,
          },
        });

        await this.audit.record(tx, {
          action: 'tenant.created',
          entityType: 'tenant',
          entityId: tenant.id,
          tenantId: tenant.id,
          actorUserId: actor.userId,
          actorMembershipId: null,
        });

        // Same transaction as the clinic: the email exists only if the clinic does.
        const clinicName = input.name.trim();
        if (user.status === 'pending') {
          const token = await this.tokens.issue(
            tx,
            user.id,
            'account_setup',
            ACCOUNT_SETUP_TTL_MS,
          );
          await this.mail.enqueue(tx, 'account_setup', {
            to: user.email,
            token,
            clinicName,
            fullName: user.fullName,
          });
        } else {
          await this.mail.enqueue(tx, 'clinic_owner', {
            to: user.email,
            clinicName,
            fullName: user.fullName,
          });
        }

        return {
          tenantId: tenant.id,
          branchId: branch.id,
          ownerUserId: user.id,
          ownerMembershipId: membership.id,
        };
      });
      this.mail.notify(); // committed: deliver now instead of at the next poll
      return result;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new DomainError('CONFLICT_UNIQUE');
      }
      throw error;
    }
  }
}
