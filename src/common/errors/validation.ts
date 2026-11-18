import { BadRequestException, type ValidationError } from '@nestjs/common';
import {
  FIELD_ERROR_CODES,
  type FieldError,
  type FieldErrorCode,
} from './error-codes.js';

const CONSTRAINT_TO_CODE: Record<string, FieldErrorCode> = {
  isNotEmpty: 'REQUIRED',
  isDefined: 'REQUIRED',
  isEmail: 'INVALID_FORMAT',
  isUUID: 'INVALID_FORMAT',
  isUuid: 'INVALID_FORMAT',
  matches: 'INVALID_FORMAT',
  isDateString: 'INVALID_FORMAT',
  isISO8601: 'INVALID_FORMAT',
  isUrl: 'INVALID_FORMAT',
  isPhoneNumber: 'INVALID_FORMAT',
  isIn: 'INVALID_VALUE',
  isTimeZone: 'INVALID_VALUE',
  isEnum: 'INVALID_VALUE',
  min: 'OUT_OF_RANGE',
  max: 'OUT_OF_RANGE',
  arrayMinSize: 'OUT_OF_RANGE',
  arrayMaxSize: 'OUT_OF_RANGE',
  minLength: 'TOO_SHORT',
  maxLength: 'TOO_LONG',
  isString: 'INVALID_TYPE',
  isInt: 'INVALID_TYPE',
  isNumber: 'INVALID_TYPE',
  isBoolean: 'INVALID_TYPE',
  isArray: 'INVALID_TYPE',
  isObject: 'INVALID_TYPE',
  whitelistValidation: 'UNKNOWN_FIELD',
};

/** Marks a 400 raised by the validation pipe so the filter can recognise it. */
export class RequestValidationException extends BadRequestException {
  constructor(readonly details: FieldError[]) {
    super('Validation failed');
  }
}

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent
      ? /^\d+$/.test(error.property)
        ? `${parent}[${error.property}]`
        : `${parent}.${error.property}`
      : error.property;
    const own = Object.keys(error.constraints ?? {}).map((constraint) => {
      const code = CONSTRAINT_TO_CODE[constraint] ?? 'INVALID_VALUE';
      return { field, code, message: FIELD_ERROR_CODES[code] };
    });
    return [...own, ...flatten(error.children ?? [], field)];
  });
}

export function validationExceptionFactory(errors: ValidationError[]) {
  return new RequestValidationException(flatten(errors));
}
