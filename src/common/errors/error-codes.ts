import { HttpStatus } from '@nestjs/common';

/**
 * Stable, machine-readable API error codes. Append-only: renaming or
 * repurposing a code is a breaking API change. Keep docs/error-codes.md in
 * sync (enforced by error-codes.spec.ts).
 */
export const ERROR_CODES = {
  // --- Active in Phase 1 ---
  VALIDATION_FAILED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Some fields need attention.',
  },
  BAD_REQUEST: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The request could not be understood.',
  },
  MALFORMED_JSON: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The request body is not valid JSON.',
  },
  PAYLOAD_TOO_LARGE: {
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    message: 'The request is too large.',
  },
  UNSUPPORTED_MEDIA_TYPE: {
    status: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
    message: 'The request content type is not supported.',
  },
  ROUTE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'The requested address does not exist.',
  },
  NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'We could not find what you were looking for.',
  },
  CONFLICT_UNIQUE: {
    status: HttpStatus.CONFLICT,
    message: 'This record already exists.',
  },
  CONFLICT_REFERENCE: {
    status: HttpStatus.CONFLICT,
    message:
      'This record is linked to other information and cannot be changed this way.',
  },
  NOT_READY: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The service is not ready yet. Please try again shortly.',
  },
  SERVICE_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      'The service is temporarily unavailable. Please try again shortly.',
  },
  INTERNAL_ERROR: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    message: 'Something went wrong on our side. Please try again.',
  },
  // --- Active in Phase 2 (guard chain) ---
  UNAUTHENTICATED: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Please sign in to continue.',
  },
  FORBIDDEN: {
    status: HttpStatus.FORBIDDEN,
    message: 'You do not have permission to do this.',
  },
  TENANT_NOT_SELECTED: {
    status: HttpStatus.FORBIDDEN,
    message: 'Please choose a clinic to continue.',
  },
  TENANT_SUSPENDED: {
    status: HttpStatus.FORBIDDEN,
    message: "This clinic's access is currently suspended.",
  },
  TENANT_DEACTIVATED: {
    status: HttpStatus.FORBIDDEN,
    message: 'This clinic is no longer active.',
  },
  TENANT_ACCESS_DENIED: {
    status: HttpStatus.FORBIDDEN,
    message: 'You do not have access to this clinic.',
  },
  // --- Active in Phase 3 (authentication) ---
  INVALID_CREDENTIALS: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'The email or password is incorrect.',
  },
  ACCESS_TOKEN_EXPIRED: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'Your session needs to be refreshed.',
  },
  TOKEN_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This link is invalid or has expired. Please request a new one.',
  },
  ROLE_NOT_ASSIGNABLE: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'This role cannot be given through an invitation.',
  },
  // --- Reserved: cataloged now so the contract is stable; no producer yet ---
  CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'This action conflicts with the current state of the record.',
  },
  METHOD_NOT_ALLOWED: {
    status: HttpStatus.METHOD_NOT_ALLOWED,
    message: 'This action is not allowed on this address.',
  },
  RATE_LIMITED: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many attempts. Please wait a moment and try again.',
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Field-level codes used inside `details[]`. */
export const FIELD_ERROR_CODES = {
  REQUIRED: 'Please fill in this field.',
  INVALID_FORMAT: 'This value is not in the expected format.',
  INVALID_TYPE: 'This value is not the expected type.',
  INVALID_VALUE: 'This value is not allowed.',
  OUT_OF_RANGE: 'This value is outside the allowed range.',
  TOO_SHORT: 'This value is too short.',
  TOO_LONG: 'This value is too long.',
  UNKNOWN_FIELD: 'This field is not accepted.',
  PASSWORD_TOO_COMMON:
    'This password is too easy to guess. Please choose another.',
  PASSWORD_CONTAINS_EMAIL: 'The password must not contain your email address.',
  PASSWORD_INCORRECT: 'The password is incorrect.',
} as const;

export type FieldErrorCode = keyof typeof FIELD_ERROR_CODES;

export interface FieldError {
  field: string;
  code: FieldErrorCode;
  message: string;
}
