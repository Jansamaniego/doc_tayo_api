import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

export interface ContextStore {
  requestId?: string;
  ip?: string;
  userId?: string;
  /** Tenant the principal asked for (from the verified credential). */
  activeTenantId?: string | null;
  /** Set only after TenantGuard verified the membership. */
  tenantId?: string;
  membershipId?: string;
  permissions?: ReadonlySet<string>;
}

const storage = new AsyncLocalStorage<ContextStore>();
const NO_PERMISSIONS: ReadonlySet<string> = new Set();

/**
 * Request-scoped context backed by AsyncLocalStorage (no extra dependency).
 * Tenant id is never a method parameter on domain services: it comes from here,
 * and only TenantGuard (after verifying membership) sets `tenantId`.
 */
@Injectable()
export class RequestContext {
  /** Runs `fn` with a fresh store; used by the HTTP middleware and by tests. */
  static run<T>(initial: ContextStore, fn: () => T): T {
    return storage.run({ ...initial }, fn);
  }

  set(values: ContextStore): void {
    const store = storage.getStore();
    if (!store) {
      throw new Error('RequestContext.set() called outside a request context.');
    }
    Object.assign(store, values);
  }

  requireTenant(): string {
    const tenantId = storage.getStore()?.tenantId;
    if (!tenantId) {
      // Programming error (a tenant-scoped code path ran without TenantGuard).
      throw new Error('No tenant in the request context.');
    }
    return tenantId;
  }

  requireUser(): string {
    const userId = storage.getStore()?.userId;
    if (!userId)
      throw new Error('No authenticated user in the request context.');
    return userId;
  }

  /** The authenticated user, or undefined outside an authenticated request. */
  get userIdOrUndefined(): string | undefined {
    return storage.getStore()?.userId;
  }
  get tenantId(): string | undefined {
    return storage.getStore()?.tenantId;
  }
  get activeTenantId(): string | null | undefined {
    return storage.getStore()?.activeTenantId;
  }
  get membershipId(): string | undefined {
    return storage.getStore()?.membershipId;
  }
  get requestId(): string | undefined {
    return storage.getStore()?.requestId;
  }
  get ip(): string | undefined {
    return storage.getStore()?.ip;
  }
  get permissions(): ReadonlySet<string> {
    return storage.getStore()?.permissions ?? NO_PERMISSIONS;
  }
}
