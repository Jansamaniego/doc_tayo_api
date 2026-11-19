import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes (256 bits), base64url: refresh, reset, setup and invitation tokens. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * SHA-256 hex of a token. Only this hash is stored. A fast hash is right here:
 * the token is 256 random bits (nothing to brute-force) and lookup is by hash.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
