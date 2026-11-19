import type { Request } from 'express';

export type PrincipalType = 'staff';

export interface Principal {
  userId: string;
  /** The session the credential belongs to (revocable server-side). */
  sessionId: string;
  /** Staff only in Phase 3; the patient portal adds another type later. */
  type: PrincipalType;
  /** Tenant the credential selects, or null when none is selected yet. */
  activeTenantId: string | null;
}

/**
 * Pluggable authentication. Production binds JwtAuthenticator (modules/auth),
 * which re-verifies the session on every request; test suites may bind a test
 * authenticator through the same token.
 */
export interface Authenticator {
  authenticate(req: Request): Promise<Principal | null>;
}

export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
