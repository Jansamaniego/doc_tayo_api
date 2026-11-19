import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';

export const IS_PUBLIC_KEY = 'doctayo:isPublic';
/** OpenAPI marker read (and removed) by `finishOpenApiDocument`. */
export const OPENAPI_PUBLIC = 'x-public';

/** No authentication, no tenant, no permissions (health checks, docs). */
export const Public = () =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    ApiExtension(OPENAPI_PUBLIC, true),
  );
