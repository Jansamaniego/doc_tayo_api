import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { DomainError } from './domain-error.js';
import { toApiError } from './to-api-error.js';
import { RequestValidationException } from './validation.js';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('internal text', {
    code,
    clientVersion: 'x',
    meta: { target: ['email'] },
  });

describe('toApiError', () => {
  it('maps DomainError to its catalog entry', () => {
    expect(toApiError(new DomainError('CONFLICT'))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
    });
  });

  it('maps validation failures with details', () => {
    const error = toApiError(
      new RequestValidationException([
        { field: 'email', code: 'INVALID_FORMAT', message: 'x' },
      ]),
    );
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(error.details).toHaveLength(1);
  });

  it.each([
    ['entity.parse.failed', 400, 'MALFORMED_JSON'],
    ['entity.too.large', 413, 'PAYLOAD_TOO_LARGE'],
    ['charset.unsupported', 415, 'UNSUPPORTED_MEDIA_TYPE'],
  ])('maps body-parser error %s', (type, status, code) => {
    expect(toApiError(Object.assign(new Error('x'), { type }))).toMatchObject({
      status,
      code,
    });
  });

  it.each([
    ['P2002', 409, 'CONFLICT_UNIQUE'],
    ['P2025', 404, 'NOT_FOUND'],
    ['P2003', 409, 'CONFLICT_REFERENCE'],
    ['P1001', 503, 'SERVICE_UNAVAILABLE'],
    ['P2010', 500, 'INTERNAL_ERROR'],
  ])('maps Prisma %s', (prisma, status, code) => {
    const result = toApiError(prismaError(prisma));
    expect(result).toMatchObject({ status, code });
    expect(JSON.stringify(result)).not.toContain('internal text');
    expect(JSON.stringify(result)).not.toContain('email');
  });

  it('maps unmatched routes, health failures and generic HttpExceptions', () => {
    expect(toApiError(new NotFoundException('Cannot GET /nope'))).toMatchObject(
      { code: 'ROUTE_NOT_FOUND' },
    );
    expect(
      toApiError(new ServiceUnavailableException({ details: 'host=secret' })),
    ).toMatchObject({ status: 503, code: 'NOT_READY' });
    expect(
      toApiError(new BadRequestException('developer text')),
    ).not.toHaveProperty('message', 'developer text');
  });

  it('hides unexpected errors behind INTERNAL_ERROR', () => {
    const result = toApiError(new Error('postgres://u:pw@host/db'));
    expect(result).toMatchObject({ status: 500, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(result)).not.toContain('postgres');
  });
});
