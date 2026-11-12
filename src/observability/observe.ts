import { randomUUID } from 'node:crypto';
import { createObserveModule, type ObserveOptions } from '@nestjs/observe';
import type { AppEnv } from '../config/env.validation.js';

/**
 * Observe's default trace id is the client's `x-request-id` header, unvalidated.
 * Use the sanitized request id set by RequestIdMiddleware instead.
 */
export const { ObserveModule, ObserveInstrument } = createObserveModule({
  traceIdGenerator: (req) =>
    (req as { requestId?: string } | undefined)?.requestId ?? randomUUID(),
  // Source fragments of captured errors would leave the process; keep off.
  sourceContext: false,
});

/** Keys masked by name in log attributes, captured headers/bodies and URLs. */
export const REDACTED_KEYS = [
  // credentials and tokens
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'setCookie',
  'otp',
  'secret',
  'apiKey',
  // patient / personal data, reserved now so later modules inherit protection
  'firstName',
  'lastName',
  'middleName',
  'fullName',
  'birthDate',
  'phone',
  'address',
  'email',
  'diagnosis',
  'notes',
  'philhealthNumber',
] as const;

/** Headers that may be recorded with a failed request (never auth or cookies). */
export const CAPTURED_HEADERS = [
  'accept',
  'content-length',
  'content-type',
  'host',
  'origin',
  'user-agent',
] as const;

export function buildObserveOptions(
  config: AppEnv['observe'],
  env: string,
): ObserveOptions {
  return {
    enabled: config.enabled,
    appKey: config.appKey,
    appSecret: config.appSecret,
    serviceId: 'doc-tayo-api',
    // Test suites must not wait on the collector.
    shutdownFlushTimeout: env === 'test' ? 0 : undefined,
    redaction: {
      enabled: true,
      useDefaultPatterns: true,
      keys: [...REDACTED_KEYS],
    },
    // Log forwarding off-box is a deliberate later decision.
    forwardLogs: false,
    http: {
      capture: { body: false, headers: [...CAPTURED_HEADERS] },
      // Search terms and identifiers in query strings can be patient data.
      queryParamsObfuscateRegex: /^(q|search|name|email|phone|birthDate)$/i,
    },
  };
}
