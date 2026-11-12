import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { DomainError } from './domain-error.js';
import { ERROR_CODES, type ErrorCode, type FieldError } from './error-codes.js';
import { RequestValidationException } from './validation.js';

export interface ApiError {
  status: number;
  code: ErrorCode;
  message: string;
  details?: FieldError[];
}

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

const PRISMA_CONNECTION_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017']);

function fromCode(code: ErrorCode, details?: FieldError[]): ApiError {
  const { status, message } = ERROR_CODES[code];
  return { status, code, message, ...(details?.length ? { details } : {}) };
}

/**
 * Maps any thrown value to a safe API error. Only catalog text is returned:
 * the original message, stack, SQL and Prisma `meta` never reach the client.
 */
export function toApiError(exception: unknown): ApiError {
  if (exception instanceof DomainError) {
    return {
      status: exception.status,
      code: exception.code,
      message: exception.message,
      ...(exception.options.details?.length
        ? { details: exception.options.details }
        : {}),
    };
  }

  if (exception instanceof RequestValidationException) {
    return fromCode('VALIDATION_FAILED', exception.details);
  }

  // Express body-parser errors carry a `type` string and an HTTP status.
  // Nest wraps them in an HttpException and keeps the original as `cause`.
  const parserType =
    (exception as { type?: unknown } | null)?.type ??
    (exception as { cause?: { type?: unknown } } | null)?.cause?.type;
  if (typeof parserType === 'string') {
    if (parserType === 'entity.parse.failed') return fromCode('MALFORMED_JSON');
    if (parserType === 'entity.too.large') return fromCode('PAYLOAD_TOO_LARGE');
    if (
      parserType === 'charset.unsupported' ||
      parserType === 'encoding.unsupported'
    ) {
      return fromCode('UNSUPPORTED_MEDIA_TYPE');
    }
  }

  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2002') return fromCode('CONFLICT_UNIQUE');
    if (exception.code === 'P2025') return fromCode('NOT_FOUND');
    if (exception.code === 'P2003' || exception.code === 'P2014') {
      return fromCode('CONFLICT_REFERENCE');
    }
    if (PRISMA_CONNECTION_CODES.has(exception.code)) {
      return fromCode('SERVICE_UNAVAILABLE');
    }
    return fromCode('INTERNAL_ERROR');
  }
  if (exception instanceof Prisma.PrismaClientInitializationError) {
    return fromCode('SERVICE_UNAVAILABLE');
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // An unmatched route is a Nest NotFoundException with no controller.
    if (
      status === HttpStatus.NOT_FOUND &&
      /^Cannot [A-Z]+ /.test(exception.message)
    ) {
      return fromCode('ROUTE_NOT_FOUND');
    }
    // Health checks (Terminus) answer 503 when a dependency is down.
    if (status === HttpStatus.SERVICE_UNAVAILABLE) return fromCode('NOT_READY');
    const code = STATUS_TO_CODE[status];
    if (code) return fromCode(code);
    return status >= 500
      ? fromCode('INTERNAL_ERROR')
      : fromCode('VALIDATION_FAILED');
  }

  return fromCode('INTERNAL_ERROR');
}
