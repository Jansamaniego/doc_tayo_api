# Plan 01 — Multi-Tenancy Foundation (Master Plan Phase 2)

> **Parent:** [`../plan.md`](../plan.md) (source of truth). This plan implements **Phase 2 — Multi-Tenancy Foundation** only.
> **Status:** **Implemented** (M0–M9 complete). Decisions D1–D7 approved as recommended (see §15). Where the code differs from the original design, the body below has been corrected to describe the code; §17 lists those deviations and why.
> **Builds on:** [`00-project-foundation.md`](00-project-foundation.md) (implemented).

Items marked **`REQUIRES APPROVAL`** are collected in §15. Statements marked **(verified)** were checked against the repository or the installed Prisma 7.10.1; everything else is a design decision or an assumption to confirm in the M1 spike.

---

## 1. Goal

Make tenant isolation **automatic and enforced** before any clinic data exists:

- the tenancy data model (tenants, branches, memberships, roles) and a minimal global `users` table;
- request-scoped tenant context derived from the authenticated principal, never from client input;
- a tenant-scoped Prisma client that every domain module must use;
- database-level guarantees (composite foreign keys) that hold even when application code is wrong;
- an append-only audit log;
- the isolation test harness every later phase reuses.

Phase 2 ships **no login**. Authentication (passwords, JWT, sessions) is Phase 3. §5 explains how Phase 2 stays testable and safe without it.

---

## 2. Baseline before Phase 2 (verified at the start of Phase 2)

| Area | State |
|---|---|
| Prisma | 7.10.1 pinned; `prisma/schema/base.prisma` only (generator + datasource); `prisma/migrations/` empty |
| Prisma syntax | A schema with `@default(uuid(7)) @db.Uuid`, `@@unique([tenantId, id])` and a composite relation `fields: [tenantId, branchId], references: [tenantId, id]` passes `prisma validate` on 7.10.1 (verified in a scratch schema). Generated SQL not yet inspected (M1). |
| `PrismaService` | Global module, extends generated `PrismaClient`, `pg` adapter, query logging off, least-privilege check at startup |
| Roles/grants | `doctayo_owner` runs migrations; `doctayo_app` has DML via default privileges (`scripts/db/grants.sql`), `NOBYPASSRLS` |
| HTTP | `applyAppSetup` (shared by `main.ts` and e2e), `AllExceptionsFilter`, error catalog with reserved `UNAUTHENTICATED`, `FORBIDDEN`, `CONFLICT` |
| Tests | Vitest unit + e2e against a `*_test` DB; `createTestApp()`; `test/architecture/forbidden-patterns.spec.ts` |
| Not present | Any guard, decorator, `AsyncLocalStorage` context, domain module, migration |

---

## 3. Scope

### 3.1 In scope

1. Prisma models + first migrations: `users` (minimal), `tenants`, `branches`, `tenant_memberships`, `permissions`, `roles`, `role_permissions`, `membership_roles`, `audit_logs`.
2. Composite-FK convention and a static registry test that enforces it.
3. `RequestContext` (Node `AsyncLocalStorage`, no new dependency).
4. Global guard chain: `AuthGuard` (pluggable authenticator) → `TenantGuard` → `PermissionsGuard`.
5. Route-category decorators: `@Public()`, `@TenantNotRequired()`, `@RequirePermissions(...)`.
6. `TenantPrismaService` (Prisma client extension) + tenant-owned model registry.
7. `AuditService` (same-transaction writes) with database-enforced append-only.
8. Tenant onboarding service (one transaction) and tenant status lifecycle (service level).
9. HTTP: `GET/PATCH /api/v1/tenant`, `GET/POST /api/v1/branches`, `GET/PATCH /api/v1/branches/:branchId`.
10. Isolation test harness with Clinic A, Clinic B and a user in both.

### 3.2 Out of scope (later phases)

| Item | Phase |
|---|---|
| Passwords, JWT, sessions, login, switch-tenant, `/me` | 3 |
| `invitations` table and acceptance flow | 3 (see §15 D2) |
| Member listing, role assignment, suspension/removal APIs, last-owner enforcement on changes | 4 |
| Platform-admin HTTP endpoints (`/api/v1/admin/*`), `@PlatformAdmin()` | 4 |
| Custom-role editing API | Future |
| PostgreSQL RLS | Phase 7 spike (design stays RLS-ready) |
| Rate limiting | 3 |

**No new npm dependencies and no new environment variables** are needed in Phase 2. Docker and Compose are unchanged; new migrations run through the existing `docker compose run --rm migrate`.

---

## 4. Data Model

Conventions from master plan §6.1 apply: `snake_case` plural tables via `@@map`, `snake_case` columns via `@map`, `id UUID @default(uuid(7))`, `created_at`/`updated_at timestamptz` on every table.

### 4.1 Files

| File | Models |
|---|---|
| `prisma/schema/identity.prisma` | `User`, `Permission` |
| `prisma/schema/tenancy.prisma` | `Tenant`, `Branch`, `TenantMembership`, `Role`, `RolePermission`, `MembershipRole` |
| `prisma/schema/audit.prisma` | `AuditLog` |

### 4.2 Tables

**Global (no `tenant_id`)**

| Table | Columns (beyond id/timestamps) | Constraints |
|---|---|---|
| `users` | `email` (normalized lower-case, trimmed), `full_name`, `status` enum `pending \| active \| deactivated`, `platform_role` enum `none \| platform_admin` | `UNIQUE(email)`; `email` is **required** (D7). **No `password_hash` in the Phase 2 migration**; Phase 3 added the credential columns (`20261119000000_authentication`). `pending` means "has no credentials yet". |
| `permissions` | `key` (`resource.action`), `description` | `UNIQUE(key)`. Rows inserted by migrations, never by the API (§4.5). |
| `tenants` | `name`, `slug`, `status` enum `active \| suspended \| deactivated`, `timezone` (IANA, default `Asia/Manila`), `contact_email?`, `contact_phone?` (E.164) | `UNIQUE(slug)`. The tenant row is the root and is not "tenant-owned". |

**Tenant-owned (`tenant_id UUID NOT NULL`, FK → `tenants(id)`, `@@unique([tenantId, id])`)**

| Table | Columns | Constraints |
|---|---|---|
| `branches` | `name`, `address_line?`, `city?`, `province?`, `timezone?` (overrides tenant), `is_active` | `UNIQUE(tenant_id, name)` |
| `tenant_memberships` | `user_id` → `users(id)`, `status` enum `invited \| active \| suspended \| removed`, `job_title?`, `joined_at?`, `removed_at?` | `UNIQUE(tenant_id, user_id)`; index `(user_id)` for "my memberships" |
| `roles` | `key`, `name`, `is_system` | `UNIQUE(tenant_id, key)` |
| `role_permissions` | `role_id`, `permission_id` → `permissions(id)` | PK `(role_id, permission_id)`; composite FK `(tenant_id, role_id)` → `roles(tenant_id, id)` |
| `membership_roles` | `membership_id`, `role_id` | PK `(membership_id, role_id)`; composite FKs `(tenant_id, membership_id)` → `tenant_memberships(tenant_id, id)` and `(tenant_id, role_id)` → `roles(tenant_id, id)` |

**Audit (tenant nullable)**

| Table | Columns | Constraints |
|---|---|---|
| `audit_logs` | `tenant_id?` → `tenants(id)`, `actor_user_id?` → `users(id)`, `actor_membership_id?`, `action` (e.g. `tenant.created`), `entity_type`, `entity_id?`, `changed_fields text[]` (names only, never values), `request_id uuid?`, `ip inet?`, `occurred_at timestamptz default now()` | Composite FK `(tenant_id, actor_membership_id)` → `tenant_memberships(tenant_id, id)` (PostgreSQL `MATCH SIMPLE`: not checked when either is null). Indexes `(tenant_id, occurred_at)`, `(entity_type, entity_id)`. No `updated_at`. |

### 4.3 Composite-FK rules (enforced by the registry test, §11.4)

1. Every tenant-owned model has `tenantId` and `@@unique([tenantId, id])`.
2. Every relation **between two tenant-owned models** uses `fields: [tenantId, xId], references: [tenantId, id]`. A row in tenant A then physically cannot reference a row in tenant B.
3. Relations from tenant-owned models to global models (`users`, `permissions`) are plain FKs.
4. `onDelete: Restrict` everywhere (nothing is cascaded away; master plan §6.5).
5. **Prefer setting scalar FK columns directly over nested relation writes** (`connect`, nested `create`) on tenant-owned relations. The M1 spike (§16) showed nested `connect` works and that cross-tenant attempts are still rejected by the composite FKs, so this is a recommendation, not a prohibition.

### 4.4 Append-only audit log

The first migration ends with:

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM doctayo_app;
```

The default privileges in `grants.sql` would otherwise give the runtime role `UPDATE`/`DELETE`. A test connects as `doctayo_app` and asserts `UPDATE`/`DELETE` fail with a permission error.

### 4.5 Permission catalog and role templates

- **Code is the source of truth:** `src/modules/access-control/catalog.ts` exports the permission keys and the role templates.
- **Phase 2 catalog (only permissions that Phase 2 routes enforce):** `tenant.read`, `tenant.settings.manage`, `branches.read`, `branches.manage`. Each later phase appends its own.
- **Role templates:** `owner` and `clinic_admin` get all four; `doctor`, `nurse`, `receptionist` get `tenant.read` and `branches.read`.
- **Getting rows into the database:** the migration that introduces a permission also inserts it (`INSERT ... ON CONFLICT DO NOTHING`) and grants it to the matching `is_system` roles of **existing** tenants (by role `key`). New tenants get role permissions from the code templates during onboarding (§8). No separate seed process is needed, so `migrate deploy` (CI, Docker, production) is the only step.
- A test asserts the `permissions` table equals the code catalog after migrations.
- `docs/authorization.md` (new) documents "how to add a permission" as a short checklist.

---

## 5. Authentication Seam (Phase 2 without login)

`TenantGuard` needs an authenticated principal, but JWTs arrive in Phase 3. Design:

```ts
// src/common/auth/authenticator.ts
export interface Principal { userId: string; activeTenantId: string | null; }
export interface Authenticator { authenticate(req: Request): Promise<Principal | null>; }
export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
```

- **Phase 2 shipped a fail-closed `DenyAllAuthenticator`** (always `null`, so every non-`@Public()` route answered `401`). **Phase 3 replaced it with `JwtAuthenticator`** (`modules/auth`), which verifies the access token and re-checks the session on every request; the class and file were deleted. Tests may still bind `TestAuthenticator`.
- **Tests bind `TestAuthenticator`** (lives in `test/support/`, never in `src/`) via `overrideProvider(AUTHENTICATOR)`. It reads `Authorization: Bearer test.<userId>.<tenantId|none>`.
- An architecture test asserts nothing under `src/` imports from `test/` or references `TestAuthenticator`.
- **Future principals (patient portal).** The guard chain must not assume that every authenticated user is a tenant member. `Principal` is expected to gain a `type` (`staff` | `patient`) in Phase 3; `TenantGuard` and `PermissionsGuard` apply to `staff` principals only, and a later portal guard authorizes `patient` principals through `patient_portal_links` (master plan §3.3 and §6). Phase 2 adds no portal code; this note only constrains how the guards are written.
- Phase 3 added `sessionId` and `type` to `Principal`; the session re-verification lives in `JwtAuthenticator` (not `TenantGuard`, because `@TenantNotRequired()` routes need it too). An addition, not a rewrite.

---

## 6. Request Context and Guards

### 6.1 `RequestContext` (`src/context/`)

- `AsyncLocalStorage<ContextStore>` from `node:async_hooks` (no `nestjs-cls` or other library).
- A raw Express middleware (`requestContextMiddleware`) runs `als.run({ requestId, ip }, next)`. It is mounted by `TenancyModule.configure()` for all routes, **after** the body parsers, not in `applyAppSetup`: Node loses AsyncLocalStorage context across body-parser's socket events if the store is opened earlier (a POST-body test covers it). Guards then fill the same store.
- `RequestContext` (injectable; static `run`/`set`, plus getters) exposes `requireTenant()`, `requireUser()`, `activeTenantId`, `permissions`, `requestId`, `ip`. `requireTenant()` throws a programming error (→ 500 `INTERNAL_ERROR`, logged) if no tenant is set.
- Tenant id is **never a method parameter** on domain services; it comes from the context.

### 6.2 Guard chain

Registered as `APP_GUARD` providers in `TenancyModule` (a global module imported by `AppModule`), in this order (Phase 3 inserts the throttler first):

| Guard | Skips when | Does | Fails with |
|---|---|---|---|
| `AuthGuard` | `@Public()` | `Authenticator.authenticate(req)`; stores `userId` | `401 UNAUTHENTICATED` |
| `TenantGuard` | `@Public()`, `@TenantNotRequired()` | Requires `activeTenantId`. **One parameterized `$queryRaw` statement** (`PrismaMembershipResolver`): membership `(tenant_id, user_id)` joined to tenant and user, plus effective permission keys via `membership_roles → role_permissions → permissions`. Checks user `active` (so `pending` users are denied), membership `active`, then tenant status (suspended/deactivated are revealed to active members only). Stores `tenantId`, `membershipId`, `permissions` | `403 TENANT_NOT_SELECTED`, `403 TENANT_SUSPENDED`, `403 TENANT_DEACTIVATED`, `403 TENANT_ACCESS_DENIED` (not a member, membership not active, or user not active) |
| `PermissionsGuard` | `@Public()`, `@TenantNotRequired()` | Requires every key in `@RequirePermissions(...)`. **A tenant-scoped route without the decorator is denied** (deny by default) | `403 FORBIDDEN` |

- Permissions are loaded per request, never cached across requests, so a role change applies on the next request.
- Health endpoints become `@Public()`.
- Cross-tenant record access returns `404 NOT_FOUND`, never 403 (master plan §5.2). `TenantGuard` logs membership denials as a security event (ids only). Logging cross-tenant record 404s is **not implemented** in Phase 2.

### 6.3 New error codes (append to the catalog and `docs/error-codes.md`)

| Code | HTTP | Message |
|---|---|---|
| `TENANT_NOT_SELECTED` | 403 | Please choose a clinic to continue. |
| `TENANT_SUSPENDED` | 403 | This clinic's access is currently suspended. |
| `TENANT_DEACTIVATED` | 403 | This clinic is no longer active. |
| `TENANT_ACCESS_DENIED` | 403 | You do not have access to this clinic. |

`UNAUTHENTICATED` and `FORBIDDEN` move from "reserved" to "active". Messages are static strings (security-privacy rule).

---

## 7. Tenant-Scoped Prisma Client

### 7.1 Shape

- `src/prisma/tenant-prisma.service.ts`: `TenantPrismaService` wraps `PrismaService.$extends({ query: { $allModels: { $allOperations } } })`.
- `src/prisma/tenant-owned-models.ts`: the registry, a `const` list of model names that have `tenantId`.
- Models **not** in the registry pass through unchanged. Domain modules still cannot reach them, because they are only given the tenant client and only query their own models (§7.4).
- `AuditLog` is exposed on the tenant client as an append-only model (`TENANT_APPEND_ONLY_MODELS`): `create` stamps the tenant, reads are tenant-scoped, update/delete are refused. This lets tenant-scoped services write audit rows in the same transaction without the unscoped client.
- `TenantPrismaService` **wraps** the extended client (the extended client itself would expose `$queryRaw`). The tenant client exposes model delegates and interactive `$transaction` only. **No `$queryRaw`/`$executeRaw`** through it: raw SQL needs explicit `tenant_id` predicates and review (master plan §3.4).

### 7.2 Operation coverage (each line is a unit/integration test)

| Operation | Behavior |
|---|---|
| `findMany`, `findFirst(OrThrow)`, `count`, `aggregate`, `groupBy`, `updateMany`, `deleteMany` | `where = { AND: [args.where ?? {}, { tenantId }] }` |
| `findUnique(OrThrow)`, `update`, `delete`, `upsert` | `tenantId` added to the unique `where` (verified in M1: `findUnique` with a foreign `tenantId` returns `null`, `update` throws `P2025`) |
| `create`, `createMany`, `createManyAndReturn`, `upsert.create` | `tenantId` injected into data. **Throw** if the caller supplied a different `tenantId` |
| `update`, `updateMany`, `upsert.update` | **Throw** if `data` contains `tenantId` (tenant of a row never changes) |
| Any operation with no tenant in context | **Throw** (programming error → 500) |
| Nested relation writes / relation filters | Not rewritten by the extension. Backstopped by composite FKs (rows can only relate within one tenant; verified in the M1 spike). Covered by explicit tests. |
| Inside an interactive `$transaction` on the tenant client | Same rules (verified in M1: query extensions apply inside interactive transactions) |

### 7.3 Global and identity access

`PrismaService` (unscoped) stays for identity/platform code: membership resolution in `TenantGuard` (`modules/tenancy`), onboarding and tenant lifecycle (`modules/tenants`), `AuditService` (`modules/audit`), health. The tenant profile service and branch service use the tenant client.

### 7.4 Who may inject what (architecture test)

| Module | `PrismaService` | `TenantPrismaService` |
|---|---|---|
| `health`, `tenancy`, `tenants`, `audit`, `access-control` (catalog/templates), and later `auth`, `users`, `admin` (allow-list in `test/architecture/prisma-access.spec.ts`) | allowed | allowed |
| All other modules (`branches` now; `patients`, `appointments`, … later) | **forbidden** | required |

---

## 8. Onboarding and Tenant Lifecycle

### 8.1 `TenantOnboardingService.onboard(input, actor)`

Input: `name`, `slug`, `timezone?`, `ownerEmail`, `ownerFullName`, `defaultBranchName` (default `Main`). Input is validated first (field-level errors; email normalized by trimming and lower-casing). One `PrismaService.$transaction`:

1. Find or create the owner `users` row (normalized email; a new user gets status `pending`).
2. Create the tenant (`active`).
3. Create the default branch.
4. Create the five system roles from templates, with their `role_permissions`.
5. Create the owner membership (`active`) with the `owner` role. (A found user keeps their status; only newly created users are `pending`, and `TenantGuard` denies `pending` users until they set a password through the emailed account-setup link, Phase 3.)
6. Write the audit entry `tenant.created` in the same transaction.

A slug conflict → `409 CONFLICT_UNIQUE` (Prisma `P2002` mapped by the service; only `slug` is unique on tenants). Any failure rolls back everything (tested by forcing a failure at step 5).

**No HTTP endpoint in Phase 2.** The platform-admin endpoint `POST /api/v1/admin/tenants` arrives in Phase 4 with `@PlatformAdmin()`. Tests call the service directly.

### 8.2 Status lifecycle (`TenantLifecycleService`)

`suspend(tenantId, actor)`, `reactivate(tenantId, actor)`, `deactivate(tenantId, actor)` (no `reason` parameter: `audit_logs` has no free-text column). Each is one conditional `updateMany` plus an audit entry in the same transaction; an invalid transition throws `CONFLICT`, an unknown tenant `NOT_FOUND`. Allowed transitions: `active ↔ suspended`, `active|suspended → deactivated`. Deactivation is one-way in Phase 2. No API deletes tenants. Effects are enforced by `TenantGuard` on the next request.

---

## 9. HTTP Endpoints

All are tenant-scoped (default category), use the tenant client, and return explicit `{ data }` / `{ data, meta }` envelopes with response DTOs (never Prisma entities).

| Method & path | Permission | Notes |
|---|---|---|
| `GET /api/v1/tenant` | `tenant.read` | Active tenant profile. |
| `PATCH /api/v1/tenant` | `tenant.settings.manage` | `name`, `timezone` (validated IANA), `contactEmail`, `contactPhone`. **Not** `slug` or `status`. Audited (`tenant.updated`, changed field names). |
| `GET /api/v1/branches` | `branches.read` | Offset pagination `?page&pageSize` (max 100), `?isActive=`. |
| `POST /api/v1/branches` | `branches.manage` | `201`. Duplicate name in the tenant → `409 CONFLICT_UNIQUE`. Audited. |
| `GET /api/v1/branches/:branchId` | `branches.read` | UUID param validation; other tenant's id → `404`. |
| `PATCH /api/v1/branches/:branchId` | `branches.manage` | Includes `isActive` (deactivate instead of delete). Audited. |

No `DELETE /branches` (master plan §6.5: deactivate when referenced; hard delete deferred until something can reference branches). Swagger documents every endpoint, DTO and error response. All return `401` in a running app until Phase 3 (§5).

---

## 10. Code Layout (new files)

```
src/
  context/                    request-context.ts, request-context.middleware.ts
  common/auth/                authenticator.ts (deny-all.authenticator.ts existed in Phase 2; removed in Phase 3)
  common/decorators/          public.decorator.ts, tenant-not-required.decorator.ts, require-permissions.decorator.ts
  common/guards/              auth.guard.ts, permissions.guard.ts
  common/dto/pagination.ts    PaginationQueryDto (first list endpoint)
  common/validation/          timezone.ts, is-time-zone.decorator.ts, trim.ts
  prisma/                     tenant-prisma.service.ts, tenant-owned-models.ts
  modules/
    tenancy/                  tenant.guard.ts, membership-resolver.ts, tenancy.module.ts (context middleware + APP_GUARDs)
    tenants/                  tenant-onboarding.service.ts, tenant-lifecycle.service.ts, tenant-profile.service.ts, tenant.controller.ts, dto/
    branches/                 branches.controller.ts, branches.service.ts, dto/
    access-control/           catalog.ts (permissions + role templates)
    audit/                    audit.service.ts
prisma/schema/                identity.prisma, tenancy.prisma, audit.prisma
prisma/migrations/            20261118000000_tenancy_foundation/ (+ audit REVOKE, permission INSERTs)
test/support/                 test-authenticator.ts, tenancy-fixtures.ts (Clinic A, Clinic B, user M), db.ts, execution-context.ts, tenant-test.controller.ts
docs/                         multitenancy.md, authorization.md (new); database.md, error-codes.md, architecture.md (updated)
docs/adr/                     0008-tenant-context.md, 0009-composite-foreign-keys.md, 0010-rls-deferred.md
```

---

## 11. Test Plan (written before implementation, per CLAUDE.md)

All database tests run against the real `doc_tayo_test` PostgreSQL. Prisma is not mocked for data behavior.

### 11.1 Database constraints (`test/tenancy-schema.e2e-spec.ts`)
- Raw insert (as the owner role in test setup) of `membership_roles` linking a Clinic A membership to a Clinic B role → FK violation.
- Same for `role_permissions` with a cross-tenant role.
- Duplicate `(tenant_id, name)` branch, `(tenant_id, user_id)` membership, `(tenant_id, key)` role, `tenants.slug`, `users.email` → unique violation.
- As `doctayo_app`: `UPDATE`/`DELETE` on `audit_logs` → permission denied; `INSERT` succeeds.
- `permissions` table equals the code catalog.

### 11.2 Tenant Prisma extension (`test/tenant-prisma.e2e-spec.ts`)
One test per row of §7.2, run with Clinic A in context against data in both clinics: reads never return B rows; `update`/`delete`/`findUnique` on a B id behave as not found and B rows are unchanged; `create` stamps A; a conflicting `tenantId` throws; changing `tenantId` throws; no context throws; behavior inside interactive transactions is the same; nested include of a related tenant-owned row never yields B data.

### 11.3 Guards and context (`test/tenancy-guards.e2e-spec.ts`, using `createTestApp` + `TestAuthenticator`)
- No/invalid principal → 401 on a tenant route; `@Public()` health still 200.
- Production binding: `JwtAuthenticator` since Phase 3 (Phase 2: `DenyAllAuthenticator`); a credential it did not issue → 401 on every non-public route.
- Principal without tenant → `403 TENANT_NOT_SELECTED`.
- Not a member / membership `suspended` or `removed` / user `deactivated` → `403 TENANT_ACCESS_DENIED`.
- Tenant `suspended` → `403 TENANT_SUSPENDED`; `deactivated` → `403 TENANT_DEACTIVATED`.
- Missing permission → `403 FORBIDDEN`; route without `@RequirePermissions` → 403.
- Role permission revoked or membership removed → **next** request is denied.
- 50 interleaved concurrent requests from Clinic A and Clinic B users → each sees only its own tenant (no context bleed).
- Unit tests: guards with `vi.fn()` collaborators for metadata handling.

### 11.4 Architecture (`test/architecture/`)
- Registry test (`test/architecture/tenant-registry.spec.ts`): every model with a `tenantId` field is in the registry, has `@@unique([tenantId, id])`, and every relation to another tenant-owned model includes `tenantId` (source: it parses `prisma/schema/*.prisma`, because Prisma 7's generated client has no `dmmf`; decided in M1).
- Route-registry test: every route is exactly one of `@Public`, `@TenantNotRequired`, or tenant-scoped **with** `@RequirePermissions`.
- Modules outside the allow-list (§7.4) do not import `PrismaService`.
- `src/` never imports from `test/`.

### 11.5 Onboarding and lifecycle (`test/tenant-onboarding.e2e-spec.ts`)
- Onboard creates tenant, default branch, five system roles with template permissions, an owner membership with the owner role, and one audit row, all in one transaction.
- Forced failure → nothing persisted.
- Existing owner email → user reused, not duplicated; email normalization (case, whitespace).
- Duplicate slug → `CONFLICT_UNIQUE`.
- Each lifecycle transition is audited; invalid transitions (e.g. reactivating a deactivated tenant) rejected.

### 11.6 Isolation matrix for the HTTP resources (`test/tenant-isolation.e2e-spec.ts`)
Fixture: Clinic A and Clinic B (owner + receptionist each) and user M (owner in A, receptionist in B). For `tenant` and `branches`, as a Clinic A user:

| Attempt | Expected |
|---|---|
| List branches | Only A's; pagination totals count only A |
| `GET`/`PATCH` a B branch id | `404`; B row unchanged |
| Body or query containing `tenantId` | `400 VALIDATION_FAILED` (`forbidNonWhitelisted`); no effect |
| `GET /tenant` | A's profile only |
| User M with tid A vs tid B | A data with owner rights; B data with receptionist rights (B `PATCH` → 403) |
| Receptionist `POST /branches` | `403 FORBIDDEN` |
| Mutations | Audit row with correct tenant, actor membership and request id; no field values stored |

Also: positive cases for each endpoint, validation failures (missing name, over-long strings, invalid timezone, invalid UUID param), boundaries (`pageSize` 100 vs 101), and log assertions that no request data appears in logs.

---

## 12. Milestones (each: tests first, then code, then the relevant suites)

| # | Milestone | Done when |
|---|---|---|
| M0 ✅ | Approvals (§15) | Decisions recorded in this file |
| M1 ✅ | **Prisma spike** (scratch, not committed): generated SQL for composite FKs; nested `connect` with a shared `tenantId`; extra fields in unique `where`; query extensions inside interactive transactions; model metadata available for the registry test; `uuid(7)` default generation | Findings recorded in §16; plan adjusted if any assumption fails |
| M2 ✅ | Schema + migration + audit `REVOKE` + permission `INSERT`s | §11.1 green; `migrate deploy` works locally, in Docker and in CI |
| M3 ✅ | `RequestContext`, authenticator seam, decorators, guard chain, new error codes; health `@Public()` | §11.3 green (using a test-only controller for tenant routes); existing Phase 1 suites green |
| M4 ✅ | `TenantPrismaService` + registry | §11.2 green |
| M5 ✅ | `AuditService` | Audit assertions in §11.1/§11.5 green |
| M6 ✅ | Onboarding + lifecycle services | §11.5 green |
| M7 ✅ | Tenant and branch endpoints + Swagger | §11.6 green |
| M8 ✅ | Architecture tests | §11.4 green |
| M9 ✅ | Docs + ADRs 0008–0010; master plan updates (§14) | Docs reviewed; lint, format, typecheck, unit, e2e, Docker build all green |

---

## 13. Phase 2 Completion Criteria (master plan §10, made testable)

- A query on a tenant-owned model without tenant context throws (§11.2).
- Cross-tenant reads/writes on branches return 404 and leave the other tenant's data unchanged (§11.6).
- Composite FKs reject cross-tenant references at the database level, tested with raw inserts (§11.1).
- Onboarding creates tenant + branch + roles + owner membership atomically and is audited (§11.5).
- Every tenant-scoped route declares permissions; undeclared routes are denied (§11.4).
- `audit_logs` cannot be updated or deleted by the runtime role (§11.1).
- No new dependencies; CI green.

---

## 14. Deviations from the Master Plan (applied to `plan.md` when Phase 2 was completed)

| # | Master plan says | This plan proposes | Why |
|---|---|---|---|
| 1 | RBAC tables, permission catalog and `PermissionsGuard` in **Phase 4** | Data model, catalog, role templates and `PermissionsGuard` in **Phase 2**; Phase 4 keeps member/role administration APIs, platform-admin endpoints and the full role × endpoint matrix | Onboarding must create roles atomically (master plan's own Phase 2 "done when"); roles are tenant-owned and are the composite-FK pattern being proven; branch endpoints must not ship without deny-by-default authorization |
| 2 | `invitations` schema in Phase 2 | Deferred to Phase 3 | Nothing in Phase 2 reads or writes it; Phase 3 owns acceptance and its token design |
| 3 | Permission catalog seeded from code | Permission rows inserted by migrations; code catalog checked against the table by a test | Works everywhere `migrate deploy` runs (CI, Docker, production) with no extra seed step |
| 4 | Read access implied for members | Explicit `tenant.read` and `branches.read` | Keeps deny-by-default uniform (every tenant route declares a permission) |
| 5 | (not specified) | `DenyAllAuthenticator` in Phase 2 (replaced by `JwtAuthenticator` in Phase 3) | Fail closed while no real authentication existed |

---

## 15. Decisions (all approved as recommended; M0 complete)

- **D1 — RBAC data model and `PermissionsGuard` move into Phase 2** (§14-1). *Recommended: approve.* Alternative: keep RBAC in Phase 4 and ship no tenant HTTP endpoints in Phase 2 (tests via test-only controllers); onboarding then cannot assign the owner role until Phase 4.
- **D2 — Defer `invitations` to Phase 3** (§14-2). *Recommended: approve.*
- **D3 — Phase 2 permission catalog and templates** (§4.5): four permissions; owner/admin full, clinical and front-desk roles read-only. *Recommended: approve; refine in Phase 4.*
- **D4 — `users.status = pending`** for users created by onboarding before Phase 3 credentials exist. *Recommended: approve.*
- **D5 — No branch deletion API in Phase 2** (deactivate only). *Recommended: approve.*
- **D6 — Enable `noImplicitOverride` and `noUncheckedIndexedAccess` now** (ADR-0002 said revisit at Phase 2 start). *Approved: enable both.*
- **D7 — `users.email` stays required and unique** (decided). Patient-portal access therefore requires an email; phone/OTP login for phone-only patients would be a separate, later feature (it would need a nullable `email` and a unique `phone`, by migration). *Approved.*

---

## 16. Spike Findings (filled in after M1)

Run on 2026-11-18 against PostgreSQL with the real schema (temporary spec, deleted after the run).

| Question | Finding |
|---|---|
| Generated SQL for composite FKs | `migrate diff` emits `FOREIGN KEY ("tenant_id","role_id") REFERENCES "roles"("tenant_id","id")` etc. exactly as designed. Two composite relations sharing `tenant_id` on `membership_roles` validate and generate correctly. Prisma adds `ON UPDATE CASCADE` (harmless: ids never change). |
| `uuid(7)` default | Works; generated ids have version nibble 7. It is a **client-side** default (no DB default), so raw SQL inserts must supply ids; tests use `gen_random_uuid()`. |
| Extra non-unique fields in a unique `where` | Works. `findUnique({ where: { id, tenantId: other } })` returns `null`; `update` with a foreign `tenantId` throws `P2025`. |
| Nested `connect` with a shared `tenantId` | Same-tenant nested connect works. Cross-tenant nested connect is rejected by the database (`membership_roles_tenant_id_membership_id_fkey`). **Rule §4.3-5 is relaxed to a recommendation**: prefer scalar FK columns, nested writes are allowed because the composite FKs backstop them. |
| Scalar cross-tenant create | Rejected with `P2003` (→ `CONFLICT_REFERENCE`). |
| Query extension inside interactive `$transaction` | Applies (`ext.$transaction(tx => tx.branch.findMany())` is filtered). |
| Extended client exposes `$queryRaw` | Yes. `TenantPrismaService` therefore **wraps** the extended client and exposes only model delegates and `$transaction`; it does not hand out the extended client itself. |
| Model metadata for the registry test | `Prisma.dmmf` is **not** available in Prisma 7's generated client. The registry test parses `prisma/schema/*.prisma` instead (and cross-checks model names against `Prisma.ModelName`). |
| Nested relation filters/includes | Not rewritten by the extension (as designed); composite FKs guarantee related rows are same-tenant. |
| `audit_logs` | Has nullable `tenant_id`, so it is **not** in the tenant-owned registry (documented exception). |
| Joint tables | `role_permissions` and `membership_roles` keep their composite PKs from §4.2 and also carry a non-PK `id` so the rule "every tenant-owned model has `@@unique([tenantId, id])`" holds without exceptions. |

---

## 17. As Built (deviations from this plan)

| Area | Plan said | As built | Why |
|---|---|---|---|
| Context middleware | Registered in `applyAppSetup` right after `requestIdMiddleware` | Mounted by `TenancyModule.configure()` (after the body parsers) | Node loses AsyncLocalStorage context across body-parser's socket events; a POST-body test covers it |
| Membership lookup | "One indexed query" via Prisma | One parameterized `$queryRaw` statement (joins membership, user, tenant, effective permissions) | `relationLoadStrategy: 'join'` needs a preview flag in 7.10.1; the raw statement is explicit and still one round trip |
| `TenantLifecycleService` | `suspend(tenantId, reason)` etc. | `suspend(tenantId, actor)`; **no `reason` parameter** | `audit_logs` stores field names only and has no free-text column; a reason would be dropped silently |
| `AuditLog` in the tenant client | Not specified | Exposed with `create`, tenant-scoped reads, and update/delete refused (`TENANT_APPEND_ONLY_MODELS`) | Tenant-scoped services must write audit rows in the same transaction without the unscoped client |
| Join tables | PK `(role_id, permission_id)` / `(membership_id, role_id)` | Same PKs plus a non-PK `id` with `UNIQUE (tenant_id, id)` | Keeps the registry rule free of exceptions |
| Tenant name uniqueness | "Slug or name conflicts -> 409" | Only `slug` is unique | The schema (§4.2) only declares `UNIQUE(slug)`; two clinics may share a display name |
| Users created by onboarding | `pending` | `pending`, and `TenantGuard` also denies `pending` users | Consistent with "user must be active"; Phase 3 activates users when they set credentials |
| Strictness flags | D6 | `noImplicitOverride` and `noUncheckedIndexedAccess` enabled (ADR-0002 amended) | As approved |
| Tests added | §11 | Also `src/**/*.spec.ts` unit tests for guards, context and audit; self-tests for the Prisma-access and route-registry checks | Those checks must be able to fail |
| Cross-tenant 404 logging | "Cross-tenant attempts are logged as a security event" (§6.2, master plan §8 item 5) | Only `TenantGuard` membership denials are logged; cross-tenant record 404s are not | No domain code distinguishes "not found" from "other tenant" (the scoped client makes them identical); logging would need a lookup that defeats the design. Revisit in Phase 7 |

**Verification at completion:** `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` (unit + architecture) and `npm run test:e2e` (real PostgreSQL) all green; the migration applied to a freshly created database with `prisma migrate deploy` and `prisma migrate diff` reported no drift; `docker build` of the runtime image succeeded. **Not run:** `docker compose run --rm migrate`, the GitHub Actions pipeline, and `npm run db:test:reset` (Prisma requires explicit user consent for the destructive reset).
