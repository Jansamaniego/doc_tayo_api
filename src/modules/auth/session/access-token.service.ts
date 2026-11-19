import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { authConfig } from '../../../config/configuration.js';

export const JWT_ISSUER = 'doctayo-api';
export const JWT_AUDIENCE = 'doctayo';
const CLOCK_TOLERANCE_SECONDS = 30;

export interface VerifiedAccessToken {
  userId: string;
  sessionId: string;
}

interface Claims {
  sub?: unknown;
  sid?: unknown;
  typ?: unknown;
}

/**
 * Signs and verifies the short-lived access JWT (HS256). The token carries NO
 * roles, permissions or tenant: those are read from the database on every
 * request (plans/02-authentication.md §5, D5).
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly clock: Clock,
    @Inject(authConfig.KEY)
    private readonly config: ConfigType<typeof authConfig>,
  ) {}

  async sign({
    userId,
    sessionId,
  }: VerifiedAccessToken): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.config.jwt.accessTtlSeconds;
    const token = await this.jwt.signAsync(
      {
        sid: sessionId,
        typ: 'staff',
        iat: Math.floor(this.clock.now().getTime() / 1000),
      },
      {
        subject: userId,
        expiresIn,
        algorithm: 'HS256',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    );
    return { token, expiresIn };
  }

  /**
   * Returns the verified identity, or null for ANY invalid token. Throws
   * ACCESS_TOKEN_EXPIRED only for a correctly signed token that has expired,
   * so the client knows to refresh.
   */
  async verify(token: string): Promise<VerifiedAccessToken | null> {
    let claims: Claims;
    try {
      claims = await this.jwt.verifyAsync<Claims>(token, {
        algorithms: ['HS256'],
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        clockTimestamp: Math.floor(this.clock.now().getTime() / 1000),
      });
    } catch (error) {
      if ((error as { name?: string })?.name === 'TokenExpiredError') {
        throw new DomainError('ACCESS_TOKEN_EXPIRED');
      }
      return null;
    }
    if (
      claims.typ !== 'staff' ||
      typeof claims.sub !== 'string' ||
      typeof claims.sid !== 'string'
    ) {
      return null;
    }
    return { userId: claims.sub, sessionId: claims.sid };
  }
}
