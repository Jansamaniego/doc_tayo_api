import { ERROR_CODES, type ErrorCode, type FieldError } from './error-codes.js';

/**
 * Business-rule error thrown by services. Status and default message come from
 * the catalog. Messages must be static text: never interpolate patient data or
 * other values, because error messages reach logs and traces.
 */
export class DomainError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    readonly options: { message?: string; details?: FieldError[] } = {},
  ) {
    super(options.message ?? ERROR_CODES[code].message);
    this.name = 'DomainError';
    this.status = ERROR_CODES[code].status;
  }
}
