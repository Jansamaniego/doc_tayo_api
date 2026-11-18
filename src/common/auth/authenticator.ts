import type { Request } from 'express';

export interface Principal {
  userId: string;
  /** Tenant the credential selects, or null when none is selected yet. */
  activeTenantId: string | null;
}

/**
 * Pluggable authentication. Phase 2 binds DenyAllAuthenticator (fail closed);
 * Phase 3 replaces the binding with the JWT authenticator.
 */
export interface Authenticator {
  authenticate(req: Request): Promise<Principal | null>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
