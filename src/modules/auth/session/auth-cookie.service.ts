import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { DomainError } from '../../../common/errors/domain-error.js';
import { Clock } from '../../../common/security/clock.js';
import { authConfig, corsConfig } from '../../../config/configuration.js';

export const REFRESH_COOKIE = 'dt_refresh';
/** The cookie is only ever sent to the auth endpoints. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * The refresh token's only transport (plans/02-authentication.md §6.3, D2):
 * an HttpOnly, SameSite=Strict cookie scoped to /api/v1/auth. It is `Secure`
 * everywhere except development. Cookie-authenticated endpoints also require
 * an Origin from CORS_ALLOWED_ORIGINS (defence in depth beside SameSite).
 */
@Injectable()
export class AuthCookieService {
  constructor(
    private readonly clock: Clock,
    @Inject(authConfig.KEY)
    private readonly auth: ConfigType<typeof authConfig>,
    @Inject(corsConfig.KEY)
    private readonly cors: ConfigType<typeof corsConfig>,
  ) {}

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.auth.cookieSecure,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    };
  }

  set(res: Response, refreshToken: string, absoluteExpiresAt: Date): void {
    const maxAge = Math.max(
      0,
      absoluteExpiresAt.getTime() - this.clock.now().getTime(),
    );
    res.cookie(REFRESH_COOKIE, refreshToken, { ...this.options(), maxAge });
  }

  clear(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.options());
  }

  read(req: Request): string | undefined {
    const value = (req.cookies as Record<string, unknown> | undefined)?.[
      REFRESH_COOKIE
    ];
    return typeof value === 'string' && value ? value : undefined;
  }

  /** Refuses a request whose Origin is missing or not an allowed origin. */
  assertAllowedOrigin(req: Request): void {
    const origin = req.headers.origin;
    if (!origin || !this.cors.allowedOrigins.includes(origin)) {
      throw new DomainError('FORBIDDEN');
    }
  }
}
