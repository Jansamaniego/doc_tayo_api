import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../context/request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditEntry {
  /** e.g. `branch.created`. */
  action: string;
  entityType: string;
  entityId?: string;
  /** Field NAMES only. Never values (they may be patient data). */
  changedFields?: string[];
  /** Defaults to the tenant in the request context; set for platform events. */
  tenantId?: string | null;
  actorUserId?: string | null;
  actorMembershipId?: string | null;
}

/** Anything with `auditLog.create`: an unscoped transaction or a tenant one. */
export interface AuditWriter {
  auditLog: { create(args: { data: AuditRow }): PromiseLike<unknown> };
}

interface AuditRow {
  tenantId?: string | null;
  actorUserId: string | null;
  actorMembershipId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  changedFields: string[];
  requestId: string | null;
  ip: string | null;
}

/**
 * Names of the fields in `patch` whose value differs from `current`.
 * Fields absent from the patch (undefined) are untouched and not listed.
 */
export function changedFieldNames(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): string[] {
  const same = (a: unknown, b: unknown) =>
    a instanceof Date && b instanceof Date
      ? a.getTime() === b.getTime()
      : a === b;
  return Object.keys(patch)
    .filter(
      (key) => patch[key] !== undefined && !same(current[key], patch[key]),
    )
    .sort();
}

/**
 * Appends audit rows. Always called with the SAME transaction client as the
 * business write, so the two commit or roll back together.
 */
@Injectable()
export class AuditService {
  constructor(private readonly context: RequestContext) {}

  /**
   * An event about the user's own account (sign-in, password, sessions): the
   * user is the actor, and it belongs to no clinic. `entityType` defaults to
   * `user` and `entityId` to the user; pass both for a `session` event.
   */
  recordAccountEvent(
    db: AuditWriter,
    {
      action,
      userId,
      entityType = 'user',
      entityId = userId,
    }: {
      action: string;
      userId: string;
      entityType?: string;
      entityId?: string;
    },
  ): Promise<void> {
    return this.record(db, {
      action,
      entityType,
      entityId,
      tenantId: null,
      actorUserId: userId,
      actorMembershipId: null,
    });
  }

  async record(db: AuditWriter, entry: AuditEntry): Promise<void> {
    const requestId = this.context.requestId;
    const ip = this.context.ip;
    await db.auditLog.create({
      data: {
        tenantId:
          entry.tenantId === undefined ? this.context.tenantId : entry.tenantId,
        actorUserId:
          entry.actorUserId === undefined
            ? (this.context.userIdOrUndefined ?? null)
            : entry.actorUserId,
        actorMembershipId:
          entry.actorMembershipId === undefined
            ? (this.context.membershipId ?? null)
            : entry.actorMembershipId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        changedFields: entry.changedFields ?? [],
        requestId: requestId && UUID.test(requestId) ? requestId : null,
        ip: ip && isIP(ip) ? ip : null,
      },
    });
  }
}
