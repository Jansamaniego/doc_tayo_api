# Architecture (Phase 1)

Modular monolith (NestJS 12, Express platform, ESM). One PostgreSQL database. See `plan.md` for the target architecture; this file describes what exists now.

```
src/
  main.ts            bootstrap: create app -> applyAppSetup -> init -> applyPostInit -> listen
  app.setup.ts       ALL global concerns (used by main.ts and by the e2e tests)
  app.module.ts      Config, Observe, Prisma, Health
  config/            env validation + typed namespaces (the only place that reads process.env)
  common/            errors (catalog, DomainError, mapping), filters, http (request id, access log), dto
  observability/     Observe wiring + redaction settings
  prisma/            PrismaService (pg adapter, least-privilege check), PrismaModule (global)
  modules/health/    liveness + readiness
  generated/prisma/  generated client (gitignored)
```

## Request lifecycle

1. `requestIdMiddleware` (raw Express, before body parsers) sets `req.requestId` and `X-Request-Id`.
2. Access-log middleware (one line per request: method, path **without query**, status, duration, request id).
3. Helmet (strict CSP; relaxed only on `/api/docs`), CORS, JSON body parser (1 MB).
4. Routing under `/api/v1` (version-neutral for health) -> validation pipe -> handler.
5. Any failure -> `AllExceptionsFilter` -> standard error shape. Unmatched routes -> `applyPostInit` handler.

Phase 2+ extension points: guards are added in `applyAppSetup` (JWT, tenant, permissions); `PrismaService` is a plain client that the tenant-scoped extension will wrap; `req.requestId` is available for audit records. Health will be marked public when the global auth guard arrives.
