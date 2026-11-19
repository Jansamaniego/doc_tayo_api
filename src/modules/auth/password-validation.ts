import { DomainError } from '../../common/errors/domain-error.js';
import { FIELD_ERROR_CODES } from '../../common/errors/error-codes.js';
import { validatePassword } from './password-policy.js';

/**
 * Applies the password policy and throws VALIDATION_FAILED with one field
 * error per problem (e.g. `newPassword: PASSWORD_TOO_COMMON`). The message
 * texts are static catalog text; the password itself is never echoed.
 */
export function assertPasswordPolicy(
  password: string,
  email: string,
  field = 'newPassword',
): void {
  const problems = validatePassword(password, { email });
  if (problems.length > 0) {
    throw new DomainError('VALIDATION_FAILED', {
      details: problems.map((code) => ({
        field,
        code,
        message: FIELD_ERROR_CODES[code],
      })),
    });
  }
}
