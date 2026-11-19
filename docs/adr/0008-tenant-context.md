# ADR-0008: Tenant context from the verified principal, via guards and AsyncLocalStorage

Status: accepted (Phase 2)

## Decision

The tenant of a request is **never** read from client input. The credential names an active tenant; `TenantGuard` verifies, on every request and in one query, that the user is an active member of an active tenant, and only then stores `tenantId`, `membershipId` and the effective permissions in `RequestContext` (Node `AsyncLocalStorage`, no new dependency). Services and `TenantPrismaService` read the tenant from the context; it is never a method parameter.

Guards, in order: `AuthGuard` -> `TenantGuard` -> `PermissionsGuard`, registered as `APP_GUARD`. Authentication is a seam (`AUTHENTICATOR`): Phase 2 bound a fail-closed `DenyAllAuthenticator`; Phase 3 binds `JwtAuthenticator` (ADR-0011) and records the active tenant on the session instead of in the token; tests may bind `TestAuthenticator`.

## Why

- A guard has route metadata (`@Public()`, `@TenantNotRequired()`, `@RequirePermissions()`) and can answer 401/403 correctly; middleware cannot.
- Tenant-in-credential rather than a URL segment or `X-Tenant-Id` header: one source of truth bound to a server-side session and no client-supplied tenant id to validate. Cost: one session = one active tenant at a time.
- Nothing is cached across requests, so role changes and removals apply on the next request.

## Consequences / findings

- The context middleware is mounted by `TenancyModule.configure()` (after the body parsers), not in `applyAppSetup`: Node loses AsyncLocalStorage context across the socket events body-parser waits on (covered by a POST-body test).
- Prisma promises are lazy; the tenant is read when the query executes, so queries must be awaited inside the request context.
- The membership lookup is one parameterized raw statement: `relationLoadStrategy: 'join'` needs a preview flag in Prisma 7.10.1, which we did not want to enable for one query.
- `Principal` carries `sessionId` and a `type` (today only `staff`; a patient portal adds `patient`) so a portal can authenticate without a membership; the tenant and permission guards apply to staff principals only.
