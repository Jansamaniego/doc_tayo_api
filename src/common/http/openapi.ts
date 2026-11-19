import type { OpenAPIObject } from '@nestjs/swagger';
import { OPENAPI_PUBLIC } from '../decorators/public.decorator.js';

const ERROR_SCHEMA = { $ref: '#/components/schemas/ErrorResponse' };

interface Operation {
  security?: Record<string, string[]>[];
  responses?: Record<string, { content?: unknown }>;
  [OPENAPI_PUBLIC]?: boolean;
}

/**
 * Two facts that hold for the whole API are applied here once instead of being
 * repeated on every handler:
 *  - every 4xx/5xx response has the standard error body;
 *  - every operation needs the bearer token unless it is `@Public()`.
 */
export function finishOpenApiDocument(document: OpenAPIObject): OpenAPIObject {
  for (const methods of Object.values(document.paths)) {
    for (const operation of Object.values(methods) as Operation[]) {
      for (const [status, response] of Object.entries(
        operation.responses ?? {},
      )) {
        if (/^[45]/.test(status)) {
          response.content = { 'application/json': { schema: ERROR_SCHEMA } };
        }
      }
      operation.security = operation[OPENAPI_PUBLIC] ? [] : [{ bearer: [] }];
      delete operation[OPENAPI_PUBLIC];
    }
  }
  return document;
}
