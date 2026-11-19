import { COMMON_PASSWORDS } from './common-passwords.js';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
/** Shorter local parts would reject ordinary passwords ("jo" is in "journey"). */
const MIN_EMAIL_LOCAL_PART = 4;

export type PasswordProblem =
  'TOO_SHORT' | 'TOO_LONG' | 'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_EMAIL';

/**
 * Passwords are compared and hashed in NFKC form so that visually identical
 * input (composed vs decomposed accents, full-width letters) is one password.
 * Nothing else is changed: no trimming, no case folding.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * Password policy (plans/02-authentication.md §8.2): 10-128 Unicode code
 * points, not on the common-password list, not containing the email. There are
 * deliberately no composition rules. Returns every problem found.
 */
export function validatePassword(
  password: string,
  { email }: { email: string },
): PasswordProblem[] {
  const normalized = normalizePassword(password);
  const length = Array.from(normalized).length;
  const problems: PasswordProblem[] = [];

  if (length < PASSWORD_MIN_LENGTH) problems.push('TOO_SHORT');
  if (length > PASSWORD_MAX_LENGTH) problems.push('TOO_LONG');

  const lower = normalized.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) problems.push('PASSWORD_TOO_COMMON');

  const address = normalizePassword(email).toLowerCase();
  const localPart = address.split('@')[0] ?? '';
  if (
    lower.includes(address) ||
    (localPart.length >= MIN_EMAIL_LOCAL_PART && lower.includes(localPart))
  ) {
    problems.push('PASSWORD_CONTAINS_EMAIL');
  }
  return problems;
}
