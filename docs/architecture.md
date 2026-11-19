# Architecture (through Phase 3)

Modular monolith (NestJS 12, Express platform, ESM). One PostgreSQL database. See `plan.md` for the target architecture; this file describes what exists now.

```
src/
  main.ts            bootstrap: create app -> applyAppSetup -> init -> applyPostInit -> listen
  app.setup.ts       ALL global concerns (used by main.ts and by the e2e tests)
  app.module.ts      Config, Clock, Observe, Prisma, Tenancy, Audit, Tenants, Branches, Users, Members, Maintenance, Health
  config/            env validation + typed namespaces (the only place that reads process.env)
  common/            errors (catalog, DomainError, mapping), filters, guards, auth seam, security (Clock, token helpers), decorators, validation, http, dto
  context/           RequestContext (AsyncLocalStorage) + its middleware
  observability/     Observe wiring + redaction settings
  prisma/            PrismaService (unscoped), TenantPrismaService (tenant-scoped extension), tenant-owned model registry
  modules/health/    liveness + readiness (public)
  modules/tenancy/   TenantGuard, membership resolver, tenant-access rule, user memberships, the global guard chain (APP_GUARD)
  modules/tenants/   onboarding + lifecycle services, GET/PATCH /tenant
  modules/branches/  GET/POST/GET :id/PATCH :id /branches
  modules/audit/     AuditService (same-transaction, append-only)
  modules/auth/      login, access tokens, sessions, refresh rotation, password recovery, account setup, invitation acceptance, JwtAuthenticator
  modules/users/     /me, /me/memberships, /me/sessions, POST /me/password
  modules/members/   invitations (create, resend; tenant client only)
  modules/mail/      transactional-outbox email (MailQueue, mail classes, outbox handler)
  modules/maintenance/  nightly cleanup job
  modules/access-control/  permission catalog + system role templates
  generated/prisma/  generated client (gitignored)
```

## Request lifecycle

1. `requestIdMiddleware` (raw Express, before body parsers) sets `req.requestId` and `X-Request-Id`.
2. Access-log middleware (one line per request: method, path **without query**, status, duration, request id).
3. Helmet (strict CSP; relaxed only on `/api/docs`), `Cache-Control: no-store` on `/api/v1/auth/*` and `/api/v1/me*`, CORS, JSON body parser (1 MB), cookie parser.
4. `requestContextMiddleware` (mounted by `TenancyModule.configure`, i.e. AFTER the body parsers) opens the AsyncLocalStorage context with the request id and IP. It cannot live in `applyAppSetup`: Node loses the context across the socket events body-parser waits on.
5. Global guards, in order: `ThrottlerGuard` (rate limits, before authentication) -> `AuthGuard` (`JwtAuthenticator`: token + session re-check -> user, session, active tenant) -> `TenantGuard` (verified membership -> tenant, permissions) -> `PermissionsGuard` (deny by default). `@Public()` skips the last three; `@TenantNotRequired()` skips the last two.
6. Routing under `/api/v1` (version-neutral for health) -> validation pipe -> handler.
7. Any failure -> `AllExceptionsFilter` -> standard error shape. Unmatched routes -> `applyPostInit` handler.

Authentication, sessions, email and the outbox are described in [authentication.md](authentication.md). Mail runs through the transactional outbox: services queue a message in their own transaction and a relay in the API process delivers it after commit. See also `docs/multitenancy.md` and `docs/authorization.md`.
