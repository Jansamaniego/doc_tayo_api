import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { Clock } from '../../common/security/clock.js';
import { generateToken, hashToken } from '../../common/security/token.js';
import { RequestContext } from '../../context/request-context.js';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailQueue } from '../mail/mail-queue.service.js';
import { TenantProfileService } from '../tenants/tenant-profile.service.js';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Roles that can never be granted by invitation (owner transfer is Phase 4). */
const NOT_ASSIGNABLE_ROLE_KEYS = new Set(['owner']);

/**
 * Create and resend invitations. Uses ONLY the tenant-scoped client: the
 * tenant comes from the context, so another clinic's roles, members and
 * invitations are simply not visible (404). The email is queued in the same
 * transaction as the invitation, so it is sent if and only if the invitation
 * was saved.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly mail: MailQueue,
    private readonly tenants: TenantProfileService,
  ) {}

  async create(input: { email: string; roleId: string }) {
    const role = await this.db.role.findUnique({ where: { id: input.roleId } });
    if (!role) throw new DomainError('NOT_FOUND');
    if (NOT_ASSIGNABLE_ROLE_KEYS.has(role.key)) {
      throw new DomainError('ROLE_NOT_ASSIGNABLE');
    }
    const existing = await this.db.tenantMembership.findFirst({
      where: { user: { email: input.email }, status: { not: 'removed' } },
      select: { id: true },
    });
    if (existing) throw new DomainError('CONFLICT');

    const clinic = await this.tenants.get();
    const membershipId = this.context.membershipId!;
    const token = generateToken();
    const row = await this.db.$transaction(async (tx) => {
      // A second OPEN invitation for the email violates the partial unique
      // index, which the error mapper turns into 409 CONFLICT_UNIQUE.
      const created = await tx.invitation.create({
        data: {
          tenantId: this.context.requireTenant(),
          email: input.email,
          roleId: role.id,
          invitedByMembershipId: membershipId,
          tokenHash: hashToken(token),
          expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MS),
        },
      });
      await this.mail.enqueue(tx.transaction, 'invitation', {
        to: input.email,
        token,
        clinicName: clinic.name,
        roleName: role.name,
      });
      await this.audit.record(tx, {
        action: 'invitation.created',
        entityType: 'invitation',
        entityId: created.id,
        changedFields: ['email', 'roleId'],
        actorMembershipId: membershipId,
      });
      return created;
    });
    this.mail.notify();
    return row;
  }

  /** New token (the old link stops working), expiry reset, email queued again. */
  async resend(invitationId: string) {
    const current = await this.db.invitation.findUnique({
      where: { id: invitationId },
    });
    if (!current) throw new DomainError('NOT_FOUND');
    if (current.acceptedAt || current.revokedAt) {
      throw new DomainError('CONFLICT');
    }

    const [role, clinic] = await Promise.all([
      this.db.role.findUniqueOrThrow({ where: { id: current.roleId } }),
      this.tenants.get(),
    ]);
    const membershipId = this.context.membershipId!;
    const token = generateToken();
    const row = await this.db.$transaction(async (tx) => {
      const updated = await tx.invitation.update({
        where: { id: invitationId },
        data: {
          tokenHash: hashToken(token),
          expiresAt: new Date(this.clock.now().getTime() + INVITATION_TTL_MS),
        },
      });
      await this.mail.enqueue(tx.transaction, 'invitation', {
        to: current.email,
        token,
        clinicName: clinic.name,
        roleName: role.name,
      });
      await this.audit.record(tx, {
        action: 'invitation.resent',
        entityType: 'invitation',
        entityId: invitationId,
        changedFields: ['tokenHash', 'expiresAt'],
        actorMembershipId: membershipId,
      });
      return updated;
    });
    this.mail.notify();
    return row;
  }
}
