import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type {
  Authenticator,
  Principal,
} from '../../../common/auth/authenticator.js';
import { AccessTokenService } from './access-token.service.js';
import { SessionService } from './session.service.js';

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

/**
 * Production authenticator. A valid signature is not enough: the session is
 * re-checked in the database on EVERY request, so logout, password change and
 * deactivation take effect on the next request (plans/02-authentication.md §5.2).
 * The token is read from the Authorization header only, never the query string.
 */
@Injectable()
export class JwtAuthenticator implements Authenticator {
  constructor(
    private readonly tokens: AccessTokenService,
    private readonly sessions: SessionService,
  ) {}

  async authenticate(req: Request): Promise<Principal | null> {
    const match = BEARER.exec(req.headers.authorization ?? '');
    if (!match?.[1]) return null;

    // Throws ACCESS_TOKEN_EXPIRED for an expired (but genuine) token.
    const verified = await this.tokens.verify(match[1]);
    if (!verified) return null;

    const session = await this.sessions.findActive(verified);
    if (!session) return null;

    return {
      userId: session.userId,
      sessionId: session.sessionId,
      type: 'staff',
      activeTenantId: session.activeTenantId,
    };
  }
}
