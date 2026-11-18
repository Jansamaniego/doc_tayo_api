import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type {
  Authenticator,
  Principal,
} from '../../src/common/auth/authenticator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Test-only authenticator (never imported by src/). Reads
 * `Authorization: Bearer test.<userId>.<tenantId|none>`.
 */
@Injectable()
export class TestAuthenticator implements Authenticator {
  authenticate(req: Request): Promise<Principal | null> {
    const header = req.headers.authorization;
    const match = /^Bearer test\.([^.]+)\.([^.]+)$/.exec(header ?? '');
    if (!match) return Promise.resolve(null);
    const [, userId, tenant] = match;
    if (!userId || !tenant || !UUID.test(userId)) return Promise.resolve(null);
    if (tenant !== 'none' && !UUID.test(tenant)) return Promise.resolve(null);
    return Promise.resolve({
      userId,
      activeTenantId: tenant === 'none' ? null : tenant,
    });
  }
}

/** Builds the Authorization header value for TestAuthenticator. */
export const bearer = (userId: string, tenantId: string | null): string =>
  `Bearer test.${userId}.${tenantId ?? 'none'}`;
