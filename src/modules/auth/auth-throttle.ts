import type { ExecutionContext } from '@nestjs/common';
import { SetMetadata } from '@nestjs/common';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { Request } from 'express';
import { normalizeEmail } from '../../common/validation/email.js';

const MINUTE = 60_000;
export const FIFTEEN_MINUTES = 15 * MINUTE;

/**
 * Rate limits (plans/02-authentication.md §9.1, D8). The throttler is the FIRST
 * global guard, so limits apply before authentication. Counters are in memory
 * (single instance, master plan); a shared store is only needed when scaled out.
 *
 * - `default`: 300/minute per IP on every route (routes override it).
 * - `ip15`: an extra per-IP limit of 30 per 15 minutes, applied only to routes
 *   marked with @IpLimited() (login), next to the per-IP+email limit.
 */
const IP_LIMITED = 'doctayo:throttle:ip15';
export const IpLimited = () => SetMetadata(IP_LIMITED, true);

export const throttlerOptions: ThrottlerModuleOptions = {
  throttlers: [
    { name: 'default', ttl: MINUTE, limit: 300 },
    {
      name: 'ip15',
      ttl: FIFTEEN_MINUTES,
      limit: 30,
      skipIf: (context: ExecutionContext) =>
        !Reflect.getMetadata(IP_LIMITED, context.getHandler()),
    },
  ],
};

/** `ip|email`: one counter per client and account (same for unknown accounts). */
export const ipAndEmailTracker = (req: Record<string, unknown>): string => {
  const body = (req.body ?? {}) as { email?: unknown };
  const email =
    typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  return `${(req as unknown as Request).ip ?? 'unknown'}|${email}`;
};

/** 5 attempts per 15 minutes per IP (+ email when the tracker says so). */
export const FIVE_PER_FIFTEEN = { limit: 5, ttl: FIFTEEN_MINUTES } as const;
