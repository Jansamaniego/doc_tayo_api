import { randomUUID } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Honors an inbound request id only if it is a canonical UUID; anything else
 * (missing, malformed, oversized, containing control characters, an array of
 * repeated headers) is replaced by a freshly generated one. This keeps
 * client-controlled text out of logs, traces and response headers.
 */
export function resolveRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && UUID_PATTERN.test(inbound)
    ? inbound.toLowerCase()
    : randomUUID();
}
