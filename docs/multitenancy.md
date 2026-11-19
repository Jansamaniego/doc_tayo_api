# Multi-tenancy (Phase 2)

One PostgreSQL database; every clinic is a **tenant**. Isolation is enforced in four independent layers so a mistake in one does not leak data. Design: `plans/01-multitenancy.md`; decisions: ADR-0008, 0009, 0010.

## The model

| Concept | Table | Scope |
|---|---|---|
| User (one per human, one email) | `users` | global |
| Tenant (clinic) | `tenants` | root |
| Membership (user in a tenant; carries status and roles) | `tenant_memberships` | tenant-owned |
| Role / role permissions / membership roles | `roles`, `role_permissions`, `membership_roles` | tenant-owned |
| Branch | `branches` | tenant-owned |
| Permission catalog | `permissions` | global, written by migrations |
| Audit log | `audit_logs` | tenant-attributed, append-only |

Roles attach to the **membership**, so one person can be an owner in one clinic and a receptionist in another.

## The four layers

1. **Request layer.** `AuthGuard` -> `TenantGuard` -> `PermissionsGuard` (`src/modules/tenancy`, `src/common/guards`). The tenant is whatever the verified credential names; `TenantGuard` then re-checks, on every request and with one query, that the user is an *active* member of an *active* tenant. Only then is `tenantId` placed in `RequestContext`. Nothing is cached across requests: a role change or removal applies on the next request.
2. **Application layer.** `TenantPrismaService` (`src/prisma`) binds every query on a tenant-owned model to the tenant in context, stamps `tenantId` on create, refuses to change it, and throws when there is no tenant.
3. **Database layer.** Relations between tenant-owned tables are **composite foreign keys** `(tenant_id, x_id) -> (tenant_id, id)`, so a row in tenant A physically cannot reference a row in tenant B, even if application code is wrong.
4. **Test layer.** Architecture tests keep the registry, the composite keys, the route categories and the Prisma-access rules honest (see below).

PostgreSQL RLS is deliberately not enabled yet (ADR-0010); the schema is RLS-ready.

## Writing tenant-scoped code

- A domain module (`branches`, later `patients`, ...) injects **`TenantPrismaService`**, never `PrismaService` (an architecture test fails the build otherwise). Only `health`, `tenancy`, `tenants`, `audit`, `access-control` (and later `auth`, `users`, `admin`) may use the unscoped client.
- The tenant id comes from `RequestContext.requireTenant()`; it is never a controller parameter, query string, body field or header. Request DTOs are `forbidNonWhitelisted`, so a client-sent `tenantId` is a `400`.
- Passing `tenantId` explicitly on create is fine (it must equal the context's); omitting it is also fine at runtime. Prefer scalar FK columns (`roleId`) over nested `connect`; nested writes work and are backstopped by the composite keys.
- No raw SQL through the tenant client (it is not exposed). Raw SQL elsewhere needs an explicit `tenant_id` predicate and review; `$queryRawUnsafe`/`$executeRawUnsafe` are forbidden by a test.
- **Prisma promises are lazy.** A query executes when it is awaited, and the tenant is read at that moment. Await inside the request (or inside `RequestContext.run` in tests); do not build a query in one context and await it in another.
- Cross-tenant record access answers `404 NOT_FOUND`, never `403`, so ids cannot be probed.
- Audit in the **same transaction** as the write: `tenantPrisma.$transaction(async (tx) => { ...write...; await audit.record(tx, { action, entityType, entityId, changedFields }) })`. Field *names* only, never values.

## Adding a tenant-owned model

1. Add `tenantId` (+ `@@unique([tenantId, id])`) and a plain relation to `Tenant` with `onDelete: Restrict`.
2. Relations to other tenant-owned models use `fields: [tenantId, xId], references: [tenantId, id]`.
3. Add the model to `TENANT_OWNED_MODELS` in `src/prisma/tenant-owned-models.ts`.
4. Expose its delegate in `TenantPrismaService` (`TenantModels`).
5. `test/architecture/tenant-registry.spec.ts` fails until 1-3 are right; add the model's cross-tenant tests to the isolation suite.

## Test harness

`test/support/tenancy-fixtures.ts` seeds Clinic A, Clinic B and user M (owner in A, receptionist in B). `TestAuthenticator` (`test/support/`) authenticates `Authorization: Bearer test.<userId>.<tenantId|none>`; `createTestApp()` binds it automatically, `createTestApp({ productionAuthenticator: true })` keeps the production `JwtAuthenticator` (the auth suites sign in for real; see [authentication.md](authentication.md)). Test-only controllers live in `test/support/` and are registered by `createTestApp`.

## Status (Phase 3)

Sign-in exists (`JwtAuthenticator`; the active tenant is stored on the session and changed with `POST /auth/switch-tenant`). Onboarding and tenant lifecycle are still services only (no HTTP endpoint until the platform-admin API in Phase 4). Users created by onboarding have status `pending` and cannot pass `TenantGuard` until they set a password through the emailed account-setup link; onboarding queues that email in the same transaction. Invitations (`invitations` is a tenant-owned registry model) are created through the tenant client; accepting one is the one public flow that writes a tenant-owned row, so it runs in `modules/auth` on the unscoped client and sets the tenant from the invitation row.

## Patient portal (planned)

Patients are tenant-owned **records**, not accounts. A future portal links a global user to patient records through a tenant-owned `patient_portal_links` table (not a column on `patients`) and uses a separate principal type; the guards here apply to `staff` principals only (plans/01-multitenancy.md §5).
