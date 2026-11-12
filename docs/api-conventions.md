# API conventions

Reference form of `plan.md` §7 for what exists in Phase 1.

- **Base path**: `/api`, URI versioning, default version `v1` → business routes are `/api/v1/<resource>`. Health is version-neutral: `/api/health`, `/api/health/ready`. Swagger UI: `/api/docs` (JSON: `/api/docs-json`), non-production only by default.
- **Unmatched routes** anywhere return the standard error (`ROUTE_NOT_FOUND`).
- **JSON**, `camelCase`, UUID ids, ISO-8601 UTC timestamps. Request bodies are limited to 1 MB.
- **Validation**: DTOs with `class-validator`/`class-transformer`. Global pipe: unknown properties are rejected (`UNKNOWN_FIELD`), types are never silently coerced (`@Type()` explicitly where needed). Failures return `VALIDATION_FAILED` with `details[]`.
- **Success shapes**: controllers return explicit `{ data }` / `{ data, meta }` (`src/common/dto/api-response.ts`). There is no global response-wrapping interceptor (ADR-0005).
- **Errors**: one shape for every failure, see [error-codes.md](error-codes.md). Services throw `DomainError(code)`; never put values (names, ids of people, query text) in error messages.
- **Request id**: every response has `X-Request-Id`. A client-sent `X-Request-Id` is honored only if it is a canonical UUID; otherwise a new one is generated. The same id appears in the error body and the logs.
- **Status codes**: 200/201/202/204 success; 400 validation or malformed; 401/403 reserved for auth; 404 not found (also used for other tenants' records later); 409 conflict; 413/415 body problems; 422 business rule; 429 reserved; 500/503 server.
- **CORS**: exact-origin allow list from `CORS_ALLOWED_ORIGINS`; allowed headers `Content-Type, Authorization, X-Request-Id, Idempotency-Key`; `X-Request-Id` is exposed to browsers.

## Adding an endpoint (checklist)

1. Controller under `src/modules/<domain>/`, thin; logic in a service.
2. DTOs with `class-validator` + `@ApiProperty`; explicit response DTO/mapper (never return Prisma entities).
3. `@ApiTags`, documented success and error responses.
4. Throw `DomainError` for business rules; add new codes to `error-codes.ts` **and** `docs/error-codes.md`.
5. Add an e2e test, including error cases.
