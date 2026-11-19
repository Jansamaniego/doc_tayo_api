import { Injectable } from '@nestjs/common';
import { DomainError } from '../../../common/errors/domain-error.js';
import {
  FIELD_ERROR_CODES,
  type FieldError,
} from '../../../common/errors/error-codes.js';
import { Clock } from '../../../common/security/clock.js';
import { hashToken } from '../../../common/security/token.js';
import {
  PrismaService,
  type PrismaTransaction,
} from '../../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { PasswordHasher } from '../password/password-hasher.js';
import { assertPasswordPolicy } from '../password/password-policy.js';

/**
 * Accepts an emailed invitation (plans/02-authentication.md §7.3). Public:
 * the token is the credential, so this runs on the unscoped client and sets
 * the tenant explicitly from the invitation row. Everything happens in one
 * transaction. There is no automatic sign-in; the client calls /auth/login.
 */
@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
  ) {}

  async accept({
    token,
    ...details
  }: {
    token: string;
    fullName?: string;
    newPassword?: string;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      const invitation = await tx.invitation.findUnique({
        where: { tokenHash: hashToken(token) },
        include: { tenant: { select: { status: true } } },
      });
      if (
        !invitation ||
        invitation.acceptedAt ||
        invitation.revokedAt ||
        invitation.expiresAt <= now
      ) {
        throw new DomainError('TOKEN_INVALID');
      }
      if (invitation.tenant.status === 'suspended') {
        throw new DomainError('TENANT_SUSPENDED');
      }
      if (invitation.tenant.status === 'deactivated') {
        throw new DomainError('TENANT_DEACTIVATED');
      }

      const user = await tx.user.findUnique({
        where: { email: invitation.email },
        select: { id: true, status: true, emailVerifiedAt: true },
      });
      if (user?.status === 'deactivated')
        throw new DomainError('TOKEN_INVALID');

      // An active user proves control of the email with the token alone. A new
      // or still-pending user must choose a name and password now.
      const needsCredentials = !user || user.status === 'pending';
      let passwordHash: string | undefined;
      let fullName: string | undefined;
      if (needsCredentials) {
        const missing: FieldError[] = [];
        fullName = details.fullName?.trim() || undefined;
        if (!fullName) {
          missing.push({
            field: 'fullName',
            code: 'REQUIRED',
            message: FIELD_ERROR_CODES.REQUIRED,
          });
        }
        if (!details.newPassword) {
          missing.push({
            field: 'newPassword',
            code: 'REQUIRED',
            message: FIELD_ERROR_CODES.REQUIRED,
          });
        }
        if (missing.length > 0) {
          throw new DomainError('VALIDATION_FAILED', { details: missing });
        }
        assertPasswordPolicy(details.newPassword!, invitation.email);
        passwordHash = await this.hasher.hash(details.newPassword!);
      }

      // Claim the invitation atomically: two concurrent accepts, one wins.
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now },
      });
      if (claimed.count !== 1) throw new DomainError('TOKEN_INVALID');

      const userId = user
        ? user.id
        : (
            await tx.user.create({
              data: {
                email: invitation.email,
                fullName: fullName!,
                status: 'active',
                passwordHash: passwordHash!,
                passwordChangedAt: now,
                emailVerifiedAt: now,
              },
              select: { id: true },
            })
          ).id;
      if (user) {
        await tx.user.update({
          where: { id: user.id },
          data: {
            emailVerifiedAt: user.emailVerifiedAt ?? now,
            ...(needsCredentials
              ? {
                  status: 'active',
                  fullName: fullName!,
                  passwordHash: passwordHash!,
                  passwordChangedAt: now,
                }
              : {}),
          },
        });
      }

      const membershipId = await this.joinTenant(tx, {
        tenantId: invitation.tenantId,
        userId,
        roleId: invitation.roleId,
        now,
      });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedUserId: userId },
      });
      await this.audit.record(tx, {
        action: 'invitation.accepted',
        entityType: 'invitation',
        entityId: invitation.id,
        tenantId: invitation.tenantId,
        actorUserId: userId,
        actorMembershipId: membershipId,
      });
    });
  }

  /** New membership, or re-activation of a removed one (unique per tenant + user). */
  private async joinTenant(
    tx: PrismaTransaction,
    {
      tenantId,
      userId,
      roleId,
      now,
    }: { tenantId: string; userId: string; roleId: string; now: Date },
  ): Promise<string> {
    const existing = await tx.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'removed') {
      throw new DomainError('CONFLICT');
    }
    if (existing) {
      await tx.membershipRole.deleteMany({
        where: { tenantId, membershipId: existing.id },
      });
      await tx.tenantMembership.update({
        where: { id: existing.id },
        data: { status: 'active', joinedAt: now, removedAt: null },
      });
    }
    const membershipId =
      existing?.id ??
      (
        await tx.tenantMembership.create({
          data: { tenantId, userId, status: 'active', joinedAt: now },
          select: { id: true },
        })
      ).id;
    await tx.membershipRole.create({
      data: { tenantId, membershipId, roleId },
    });
    return membershipId;
  }
}
