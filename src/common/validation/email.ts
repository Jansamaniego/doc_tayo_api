/** Canonical form of an email address: trimmed and lower-case. */
export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();
