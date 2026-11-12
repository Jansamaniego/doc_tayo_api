# DocTayo Backend — Master Development Plan

> **Scope:** Backend only (`doc-tayo-api`). The frontend has its own independent plan. This document only describes API contracts the frontend will consume, never frontend implementation.
>
> **Status:** Draft for approval. No implementation starts until this plan is approved.
>
> **Child plans** (must stay consistent with this document):
> `plans/01-multitenancy.md` · `plans/02-authentication.md` · `plans/03-user-management-and-authorization.md` · `plans/04-core-clinic-apis.md` · `plans/05-additional-clinic-apis.md`

---

## 0. Current State of the Project (as inspected)

| Area | Current state | Implication |
|---|---|---|
| Framework | NestJS `12.4`, `@nestjs/platform-express` | Keep Express. `NodeAdapter` is faster but not needed now. |
| Module system | ESM (`"type": "module"`, `nodenext`) | Relative imports end in `.js`; use `import.meta.dirname`. |
| Language | TypeScript 6, `strict: true` | Keep strict mode. |
| Tests | Vitest 4 (`*.spec.ts`, `*.e2e-spec.ts`), supertest | Mocks are `vi.fn()`. No Jest. |
| Lint/format | oxlint (type-aware), Prettier | Keep. |
| Observability | `@nestjs/observe` in `app.module.ts` (traces, logs, errors, metrics) | Use it as the logging/tracing backbone. Must enforce PHI redaction. |
| ORM | `prisma@8.0.0-rc.33` (CLI, **pre-release**) + `@prisma/client@7.10.1` (stable) | **Mismatched major versions — decision required** (see §15, Q1). |
| Prisma config | `prisma.config.ts` has only the Prisma 8 `skills` section | No schema, no datasource, no migrations yet. |
| Database | Not configured (`.env` has only Observe keys) | Phase 1 adds PostgreSQL + `DATABASE_URL`. |
| Domain code | Only the default `AppController`/`AppService` | Greenfield. |

Decisions already made by the scaffold: NestJS 12, ESM, Vitest, oxlint, Express, Observe. This plan keeps all of them.

---

## 1. Architectural Summary

- **Modular monolith** in a single NestJS application. No microservices.
- **One PostgreSQL database, `public` schema**, shared by all tenants and all domains (identity, tenancy, clinic operations).
- **Shared-schema multi-tenancy** with a non-null `tenant_id` on every tenant-owned table.
- **Tenant isolation in three layers**:
  1. **Request layer** — tenant context is derived from the authenticated session and membership is re-verified on every request (never trusted from the client).
  2. **Data-access layer** — a tenant-scoped Prisma client automatically scopes every query on tenant-owned models.
  3. **Database layer** — composite foreign keys `(tenant_id, id)` make cross-tenant references impossible. PostgreSQL RLS is designed-for and evaluated later as defense-in-depth (§3.6).
- **Global identity, tenant-scoped authorization**: one `users` row per human; roles and permissions attach to a **tenant membership**, not to the user.
- **REST API** under `/api/v1`, documented with Swagger/OpenAPI, validated with DTOs + `class-validator`.
- **Auth**: short-lived JWT access tokens + opaque, rotated, server-stored refresh tokens (sessions). Argon2id password hashing.
- **Privacy by design**: patient data is sensitive personal information; audit logging, least privilege, minimal logging of PHI, and no hard deletion of clinical records.

---

## 2. Technology Stack

| Concern | Choice | Notes |
|---|---|---|
| Framework | NestJS 12 (existing) | Prefer first-party `@nestjs/*` packages (see AGENTS.md). |
| Language | TypeScript (strict, ESM) | |
| ORM | Prisma | Version decision pending (Q1). Recommended: matched stable Prisma 7.x CLI + client with the `pg` driver adapter. |
| Database | PostgreSQL 17+ (18 preferred) | Single database, `public` schema. |
| API docs | `@nestjs/swagger` | OpenAPI 3; served at `/api/docs` in non-production only (or behind auth). |
| Validation | DTOs + `class-validator` / `class-transformer` via global `ValidationPipe` | `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`. |
| Config | `@nestjs/config` with schema-validated env at startup | App refuses to boot with invalid config. |
| Auth | JWT (`@nestjs/jwt`, or `@nestjs/authentication` after evaluation) | Evaluate first-party `@nestjs/authentication`/`@nestjs/authorization` at Phase 3/4 start; adopt if they fit the design here, otherwise implement guards directly. |
| Password hashing | Argon2id (`argon2` package) | OWASP-recommended parameters (§8.1). |
| Rate limiting | `@nestjs/throttler` | In-memory store while single-instance; shared store when scaled out. |
| Health checks | `@nestjs/terminus` | `/api/health` (liveness), `/api/health/ready` (DB). |
| Scheduled work | `@nestjs/schedule` (+ `@nestjs/locks` when multi-instance) | Token cleanup, reminders. |
| Async side effects | Transactional outbox (evaluate `@nestjs/outbox`) | Emails/SMS sent after commit. No Redis until justified. |
| Idempotency | Evaluate `@nestjs/idempotency` | For appointment booking and payments. |
| Email | `@nestjs/mail` | Provider TBD (Q6). |
| Observability | `@nestjs/observe` (existing) | |
| Security headers | `helmet` | |

**Explicitly not introduced:** Redis, message brokers, separate auth database, separate schemas per tenant, GraphQL, microservices, a second ORM.

> Uncertainty: NestJS 12 first-party packages listed in AGENTS.md (`@nestjs/authentication`, `@nestjs/authorization`, `@nestjs/outbox`, `@nestjs/idempotency`, `@nestjs/mail`) were not verified in detail for this plan. Each child plan must confirm the API against https://docs.nestjs.com before adopting it.

---

## 3. Multi-Tenancy Architecture

### 3.1 Concepts

| Concept | Definition |
|---|---|
| **Tenant** | A clinic *organization* (the legal/business entity). Owns all clinic data. |
| **Branch** | A physical location belonging to one tenant. A tenant has ≥ 1 branch. |
| **User** | A global identity (one per human, one email). Not tenant-owned. |
| **Membership** | The link between a user and a tenant (`tenant_memberships`). Carries status and roles. A user may have memberships in many tenants with different roles. |
| **Active tenant** | The single tenant a request operates in, bound to the user's session. |

### 3.2 Global vs tenant-owned data

| Global (no `tenant_id`) | Tenant-owned (`tenant_id NOT NULL`) |
|---|---|
| `users` | `branches` |
| `sessions` (refresh tokens) | `tenant_memberships` |
| `user_tokens` (password reset, email verification) | `roles`, `role_permissions`, `membership_roles` |
| `permissions` (code-defined catalog) | `invitations` |
| `tenants` (the tenant row itself) | `patients`, `appointments`, encounters, diagnoses, prescriptions, services, invoices, payments, notifications… |
| — | `audit_logs` (`tenant_id` nullable only for platform/identity events) |

Rule: **every table that holds tenant data has its own `tenant_id` column — including join tables.** No table infers its tenant only through a parent. This keeps scoping uniform and makes RLS possible later without schema changes.

### 3.3 Tenant context: how a request gets its tenant

**Recommended approach: guard + request-scoped context store (AsyncLocalStorage), not middleware alone.**

1. User logs in → session created.
2. If the user has exactly one active membership, it becomes the active tenant automatically. Otherwise the client calls `POST /api/v1/auth/switch-tenant`.
3. The server verifies an **active membership** in an **active tenant**, records `active_tenant_id` on the session, and issues a new access token carrying `tid` (tenant id).
4. On every request, `TenantGuard` (runs after authentication):
   - reads `tid` from the verified token (never from a body/query/header);
   - re-verifies in one indexed query that the session is still active, the membership is still active, and the tenant is still active;
   - loads the membership's effective permissions;
   - stores `{ userId, sessionId, tenantId, membershipId, permissions }` in a `RequestContext` (AsyncLocalStorage).
5. Services and the tenant-scoped Prisma client read the tenant from `RequestContext`. **Tenant id is never a method parameter supplied by controllers.**

Why a guard and not middleware: guards run after authentication, have access to route metadata (`@Public()`, `@TenantNotRequired()`), and can return proper 401/403. Middleware is used only for cross-cutting non-auth concerns (request id, security headers).

Why tenant-in-token rather than tenant-in-URL or `X-Tenant-Id` header: one source of truth bound to a server-side session, simpler API paths (`/api/v1/patients`), no client-supplied tenant id to validate. Trade-off: one session = one active tenant at a time (separate logins/sessions are needed for simultaneous work in two clinics). Acceptable for the target users.

Route categories (every route must be exactly one — enforced by a test, §11.6):
- `@Public()` — no auth (login, refresh, password reset, health).
- `@TenantNotRequired()` — authenticated, no active tenant needed (`/me`, `/me/memberships`, switch-tenant, create tenant).
- Default — authenticated **and** tenant-scoped.
- `@PlatformAdmin()` — platform operator routes under `/api/v1/admin/*`.

### 3.4 Enforcing isolation without relying on developer memory

- **Tenant-scoped Prisma client** (Prisma Client extension): for every model in a registry of tenant-owned models, it injects `tenantId` from `RequestContext` into `where` for reads/updates/deletes and into `data` for creates. If a tenant-owned model is queried with no tenant in context, it **throws**.
- **Unscoped access is explicit**: the raw `PrismaService` is only injectable in identity/platform modules (`auth`, `users`, `tenants`, `admin`). Domain modules receive only the tenant-scoped client. Lint/test checks enforce this (§11.6).
- **`findUnique` by id is replaced by tenant-aware lookups** (`findFirst({ where: { id } })` through the scoped client, or composite unique `tenantId_id`).
- **Composite foreign keys** (§6.4) make cross-tenant references fail at the database even if application code is wrong.
- **Raw SQL** (`$queryRaw`) is allowed only in repositories with explicit `tenant_id` predicates and requires review; a test asserts tenant filtering for each raw query.
- **Known limitation**: Prisma extensions do not cover every nested-write/relation-filter path perfectly. Mitigation: composite FKs + isolation test matrix (§11.5). Child plan 01 must document exactly which operations the extension covers.

### 3.5 Tenant lifecycle

| Stage | Behavior |
|---|---|
| **Creation / onboarding** | One transaction creates: tenant (`status = active`), default branch, default roles from templates, owner membership for the creating user, audit entry. Initially **provisioned by a platform admin** (controlled pilot); a self-service signup endpoint can be enabled later by config (Q3). |
| **Configuration** | Owner/admin manages profile (name, contact, timezone default `Asia/Manila`), branches, staff invitations, roles. |
| **Membership management** | Invite by email → `invitations` row (hashed token, 7-day expiry) → acceptance creates/activates membership. Statuses: `invited`, `active`, `suspended`, `removed`. Invariant: a tenant always has ≥ 1 active owner; the last owner cannot be removed or demoted. |
| **Switching** | `POST /auth/switch-tenant` (§3.3). Last-used tenant stored on the session for convenience. |
| **Suspension** | `status = suspended` (e.g., non-payment, investigation): all tenant-scoped requests return `403 TENANT_SUSPENDED`; data untouched. Reversible. |
| **Deactivation** | `status = deactivated` at owner/platform request: access blocked, data export offered, data retained for the retention period (§8.13). |
| **Deletion** | Only after retention period, by platform admin, as a documented, audited purge job. Never an API `DELETE` on tenants. |

### 3.6 PostgreSQL Row-Level Security (RLS) — assessment

**Recommendation: do not enable RLS in the initial phases; design every table so RLS can be added later without schema change, and run an RLS spike in Phase 7 (or earlier if Q2 says so) on the most sensitive tables.**

Assessment:
- RLS needs the current tenant per connection (e.g., `current_setting('app.tenant_id')`). Prisma uses a connection pool, so a session-level `SET` would leak between requests.
- The safe pattern is `set_config('app.tenant_id', $1, true)` (transaction-local) **inside the same transaction as every query**. With Prisma that means wrapping each operation (or each request) in a transaction via a client extension: extra round trip per query, care with nested/interactive transactions, and longer-held connections. Works with PgBouncer in transaction mode because the setting is transaction-local.
- The application must connect as a **non-owner, non-superuser role** (table owners bypass RLS unless `FORCE ROW LEVEL SECURITY`). Migrations run under a separate owner role. **This role separation is adopted from Phase 1 regardless**, because it is good least-privilege practice and keeps the RLS door open.
- Conclusion: valuable defense-in-depth for `patients` and clinical tables, but its cost/complexity should be measured, not assumed. The three-layer approach in §3.4 is the required baseline.

---

## 4. Authentication and Account Management

### 4.1 Responsibilities

| Concern | Owner module | Question it answers |
|---|---|---|
| **Authentication** | `auth` | Who is this? (valid credentials, valid session/token) |
| **Tenant membership validation** | `tenancy` (`TenantGuard`) | Is this user an active member of the active, active tenant? |
| **Authorization (RBAC)** | `access-control` (`PermissionsGuard`) | Does the membership's role grant this permission? |
| **Resource-level access** | Each domain service | May this member act on *this specific record*? (e.g., only the authoring doctor may amend a draft note) |

Authentication knows nothing about clinic business logic; it lives in the same database but in its own module with its own tables.

### 4.2 Tokens and sessions

| Item | Decision |
|---|---|
| Access token | JWT, 15 min TTL, signed with a strong secret (HS256) held only by the API. Claims: `sub` (user id), `sid` (session id), `tid` (active tenant id or null), `iat`, `exp`. **No roles/permissions in the token** — loaded per request so revocations apply immediately. |
| Refresh token | Opaque 256-bit random value. Stored **only as a SHA-256 hash** in `sessions`. |
| Rotation | Each refresh issues a new refresh token and invalidates the old one. |
| Reuse detection | Presenting an already-rotated refresh token revokes the whole session family (likely theft). |
| Lifetimes | Idle timeout 14 days, absolute 30 days (configurable). Chosen to avoid frequent re-login for older users while bounding risk. |
| Per-request session check | `TenantGuard`/`JwtAuthGuard` confirms the session is not revoked (indexed lookup, combined with the membership query). Logout is effective immediately. |
| Transport | Refresh token delivery mechanism (httpOnly cookie vs response body) depends on frontend deployment topology — **Q5**. Default: httpOnly, `Secure`, `SameSite=Strict` cookie scoped to `/api/v1/auth`; access token in the JSON response body. |

### 4.3 Account flows

| Flow | Endpoint (representative) | Key rules |
|---|---|---|
| Account creation | Via invitation acceptance or tenant onboarding; public self-registration **off by default** (Q3) | Email normalized (trimmed, lowercased) and unique. |
| Email verification | `POST /auth/email/verify` | Required before first login for self-registered accounts; accepting an emailed invitation counts as verification. |
| Login | `POST /auth/login` | Generic failure message (`INVALID_CREDENTIALS`); throttled (§8.9). Response includes the user's memberships so the client can choose a tenant. |
| Refresh | `POST /auth/refresh` | Rotation + reuse detection. |
| Logout | `POST /auth/logout` | Revokes current session. |
| Logout everywhere | `POST /auth/logout-all` | Revokes all user sessions. |
| Switch tenant | `POST /auth/switch-tenant` | Verifies membership; new access token with `tid`. |
| Current user | `GET /me` | Profile + active tenant + effective permissions in that tenant. |
| Profile | `PATCH /me` | Global profile fields only (name, phone). Email change requires re-verification. |
| Change password | `POST /me/password` | Requires current password; revokes all other sessions. |
| Forgot password | `POST /auth/password/forgot` | Always returns `202` (no account enumeration). Single-use hashed token, 30 min expiry. |
| Reset password | `POST /auth/password/reset` | Consumes token, revokes all sessions. |
| Sessions | `GET /me/sessions`, `DELETE /me/sessions/:id` | Device/IP/last-used metadata. |
| Activation/deactivation | Platform admin: `PATCH /admin/users/:id/status` | Deactivated users cannot log in; all sessions revoked. Tenant admins suspend **memberships**, not global accounts. |
| Assisted reset | Tenant admin can re-send an invitation/reset email for a member | Supports staff who struggle with self-service; admin never sees or sets passwords. |

---

## 5. Authorization (RBAC)

### 5.1 Model

- **Permissions** — a global, code-defined catalog (seeded, not user-editable), keyed as `resource.action`: `patients.read`, `patients.write`, `medical_records.read`, `medical_records.write`, `prescriptions.issue`, `appointments.manage`, `billing.manage`, `members.manage`, `roles.manage`, `branches.manage`, `audit_logs.read`, `tenant.settings.manage`…
- **Roles** — **tenant-owned**. On tenant creation, default roles are created from code-defined templates: Clinic Owner, Clinic Administrator, Doctor, Nurse, Receptionist. Roles have `is_system` (template-derived; protected from deletion) and a stable `key`.
- **Role permissions** — `role_permissions (tenant_id, role_id, permission_id)`.
- **Membership roles** — `membership_roles (tenant_id, membership_id, role_id)`. Roles attach to the membership (user-in-tenant), which is how "different roles in different tenants" works. This replaces the proposed `user_roles` table.
- **Platform (global) roles** — minimal: a `platform_role` on `users` (`none`, `platform_admin`, optionally `support`). Platform admins manage tenants and accounts via `/api/v1/admin/*`; they do **not** automatically get access to tenant clinical data.
- **Custom roles** — the schema supports tenant-defined roles from day one; the **API for creating/editing custom roles is a future enhancement**. Initially tenants assign the default roles only.

### 5.2 Enforcement in NestJS

Global guard order:

1. `ThrottlerGuard`
2. `JwtAuthGuard` — verifies the token; skipped for `@Public()`.
3. `TenantGuard` — membership/session/tenant validation; populates `RequestContext`; skipped for `@TenantNotRequired()`.
4. `PermissionsGuard` — checks `@RequirePermissions('patients.write')` against the context. **A tenant-scoped route without `@RequirePermissions` fails the route-registry test** (deny by default).
5. **Resource-level checks** in services, through small policy functions per domain (e.g., `EncounterPolicy.canAmend(ctx, encounter)`), not ad-hoc `if`s in controllers.

Cross-tenant access to a record returns **404 Not Found**, not 403, so record existence is not leaked.

---

## 6. Database Architecture and Schema Standards

### 6.1 Naming and types

| Rule | Standard |
|---|---|
| Tables | `snake_case`, **plural** (`patients`, `tenant_memberships`) via Prisma `@@map`. |
| Columns | `snake_case` via `@map`; Prisma fields are `camelCase`, models `PascalCase` singular. |
| Primary keys | `id UUID`, UUIDv7 generated by Prisma (`@default(uuid(7)) @db.Uuid`) — time-ordered, index-friendly, non-guessable enough to not reveal counts. |
| Foreign keys | `<entity>_id`, always with a real FK constraint and an index. |
| Timestamps | `created_at`, `updated_at` as `timestamptz` on every table; all stored in UTC. |
| Calendar dates | `date` type (e.g., `birth_date`) — never a timestamp. |
| Money | `numeric(12,2)` + `currency` (`PHP` default). Never floating point. |
| Enums | PostgreSQL enums via Prisma for stable sets (statuses); lookup tables for tenant-configurable sets. |
| Booleans | `is_` / `has_` prefix. |
| Emails | Stored normalized (lowercase, trimmed) with a unique index. |
| Phone numbers | Stored normalized E.164 (`+63…`). |
| Optimistic locking | `version INT` on concurrently edited records (appointments, encounters, invoices). |
| Audit columns | `created_by_membership_id` / `updated_by_membership_id` on clinical and financial records. |
| Prisma schema files | Multi-file schema, one file per domain (`prisma/schema/identity.prisma`, `tenancy.prisma`, `patients.prisma`…). |

### 6.2 Foundational entities (outline only — finalized in child plans)

| Table | Scope | Purpose / key constraints |
|---|---|---|
| `users` | Global | Identity, `email` unique, `password_hash` (globally omitted from Prisma results), `status`, `platform_role`, `email_verified_at`, `failed_login_count`, `locked_until`. |
| `sessions` | Global | Refresh token hash, family id, `active_tenant_id`, user agent, IP, `last_used_at`, `expires_at`, `revoked_at`. |
| `user_tokens` | Global | Hashed single-use tokens, `type` (`email_verification`, `password_reset`), `expires_at`, `used_at`. |
| `tenants` | Global (the root) | Name, slug unique, status, default timezone, contact details. |
| `branches` | Tenant | `UNIQUE(tenant_id, name)`, address, timezone override, status. |
| `tenant_memberships` | Tenant | `UNIQUE(tenant_id, user_id)`, status, job title, joined/removed dates. |
| `invitations` | Tenant | Email, intended roles, hashed token, expiry, accepted/revoked timestamps. |
| `permissions` | Global | `key` unique, description. Seeded from code. |
| `roles` | Tenant | `UNIQUE(tenant_id, key)`, `is_system`. |
| `role_permissions` | Tenant | PK `(role_id, permission_id)`. |
| `membership_roles` | Tenant | PK `(membership_id, role_id)`. |
| `audit_logs` | Tenant (nullable for platform events) | Append-only (§8.12). |

### 6.3 Future clinic entities — rationalized

| Proposed | Decision |
|---|---|
| Patients | `patients` — tenant-owned **records**, not login accounts. The same person at two clinics is two separate patient records (no cross-tenant patient identity — a privacy decision). Optional `user_id` link reserved for a future patient portal. |
| Doctors / Staff | **No separate `doctors` or `staff` tables duplicating people.** Staff = `tenant_memberships`. Doctor-specific data (PRC license no., specialization, PTR/S2 numbers, schedules) lives in `practitioner_profiles` (1:1 with membership). Doctors are identified by having the Doctor role + a practitioner profile. |
| Appointments | `appointments` — branch, patient, practitioner membership, optional service, `starts_at`/`ends_at`, status state machine. Double-booking prevented by a PostgreSQL **exclusion constraint** (added via raw SQL in the migration; Prisma cannot express it). |
| Medical records | Anchored on **`encounters`** (a visit/consultation) with clinical notes, vital signs, attachments metadata. Finalized notes are immutable; corrections are **amendments** (new rows linked to the original). |
| Diagnoses | `diagnoses` per encounter, ICD-10 coded where possible. |
| Prescriptions | `prescriptions` + `prescription_items` per encounter; generic name required (rules to be confirmed with clinicians). |
| Services | `services` — tenant price list/catalog (consultation, procedures), optionally per-branch pricing. |
| Billing / Payments | `invoices`, `invoice_items`, `payments` (partial payments, refunds as separate rows). Discounts (e.g., Senior Citizen / PWD) modeled explicitly — rules to be confirmed (Q8). |
| Notifications | `notifications` + outbox; channels email first, SMS later (Q6). |
| Audit logs | Foundation built in Phase 2 (moved earlier than requested — see §10). |

### 6.4 Cross-tenant integrity (database level)

- Every tenant-owned table declares `@@unique([tenantId, id])`.
- Every reference between tenant-owned tables is a **composite FK**: e.g., `appointments(tenant_id, patient_id) → patients(tenant_id, id)`. A row in tenant A physically cannot reference a row in tenant B.
- Tenant-aware uniqueness: business identifiers are unique per tenant, e.g., `UNIQUE(tenant_id, patient_number)`, `UNIQUE(tenant_id, invoice_number)`.
- Indexes lead with `tenant_id` (e.g., `(tenant_id, last_name, first_name)`, `(tenant_id, branch_id, starts_at)`).
- Patient name search uses `pg_trgm` trigram indexes (tolerant search for misspellings) — added when patient search is built.

### 6.5 Deletion and archival

| Data | Strategy |
|---|---|
| Clinical records (encounters, notes, diagnoses, prescriptions) | **Never deleted via API.** Void/amend with reason; retained per retention policy. |
| Patients | Archive (`archived_at`); merge-duplicates is a future feature. Hard delete only via audited retention/erasure job. |
| Financial records | Immutable once issued; corrections via void + reissue or credit entries. |
| Configuration (branches, services, roles) | Deactivate (`is_active = false`) if referenced; hard delete only if never used. |
| Memberships | Status `removed`; row kept for audit history. |
| Tokens/sessions | Hard deleted by scheduled cleanup after expiry. |

No global "soft delete" magic: each model's archival behavior is explicit in its repository/service.

### 6.6 Migrations

- `prisma migrate dev` locally; `prisma migrate deploy` in the release pipeline; migrations committed and reviewed.
- Raw SQL in migrations for what Prisma cannot model (exclusion constraints, `pg_trgm`, check constraints, future RLS policies).
- Migrations run as the DB owner role; the app runs as a restricted role (§3.6).
- Seeds: permissions catalog and role templates (idempotent); dev-only demo data in a separate script that refuses to run in production.

---

## 7. REST API Conventions

### 7.1 General

- Base path: `/api/v1` (Nest global prefix `api` + URI versioning). Breaking changes → `/api/v2` for affected resources only.
- Resource nouns, plural, kebab-case: `/patients`, `/tenant-memberships` → simplified as `/members`.
- Tenant is **implicit** from the session (§3.3). No `tenantId` in paths or bodies of tenant-scoped routes.
- JSON, `camelCase` fields. IDs are UUID strings.
- State transitions that are not simple field edits are **action sub-resources**: `POST /appointments/:id/cancel`, `POST /encounters/:id/finalize`, `POST /invoices/:id/void`. Each requires a reason where clinically/financially relevant.

### 7.2 Methods and status codes

| Case | Status |
|---|---|
| Read | `200` |
| Create | `201` + body |
| Async accepted (emails) | `202` |
| Delete/no content | `204` |
| Validation error | `400` (`VALIDATION_FAILED`) |
| Not authenticated / token expired | `401` |
| Authenticated but not permitted / tenant suspended | `403` |
| Not found **or belongs to another tenant** | `404` |
| Conflict (unique violation, version mismatch, double booking) | `409` |
| Business rule violation | `422` |
| Rate limited | `429` |
| Server error | `500` (no internals leaked) |

`PATCH` for partial updates; `PUT` only for full replacement (rare). Mutations on versioned resources require `version` in the body (or `If-Match`); mismatch → `409 VERSION_CONFLICT`.

### 7.3 Response shapes

```jsonc
// Single resource
{ "data": { "id": "…", "firstName": "Juan", "…": "…" } }

// Collection
{ "data": [ … ], "meta": { "page": 1, "pageSize": 20, "totalItems": 134, "totalPages": 7 } }

// Error
{
  "error": {
    "status": 400,
    "code": "VALIDATION_FAILED",            // stable, machine-readable, documented
    "message": "Some fields need attention.", // plain language
    "details": [ { "field": "birthDate", "code": "INVALID_DATE", "message": "Birth date must be a valid date." } ],
    "requestId": "01J…"
  }
}
```

Error `code`s are a documented, stable catalog (`docs/error-codes.md`). The frontend maps codes to friendly, large-print messages; the backend's `message` is a plain-language fallback. Stack traces, SQL, and Prisma error text are never returned.

### 7.4 Pagination, filtering, sorting, searching

- Offset pagination by default: `?page=1&pageSize=20` (max 100).
- Cursor pagination for append-heavy streams (audit logs, notifications): `?cursor=…&limit=50`.
- Filtering via explicit, whitelisted query params: `?status=scheduled&branchId=…&from=2026-11-01&to=2026-11-30`.
- Sorting: `?sort=lastName,-createdAt` (whitelisted fields only).
- Search: `?q=dela cruz` (tolerant, trigram-backed for patients).

### 7.5 Idempotency, transactions, concurrency

- `Idempotency-Key` header supported (and recommended for clients) on `POST` that create appointments, invoices, and payments — protects against double submission from double clicks or retries.
- Every multi-write business operation runs in one Prisma transaction (e.g., tenant onboarding, finalize encounter + audit entry, record payment + update invoice balance).
- Audit log entries for a mutation are written **in the same transaction** as the mutation.

### 7.6 Dates and time zones

- All instants stored as `timestamptz` (UTC) and returned as ISO 8601 with `Z`.
- Each tenant has a default IANA timezone (`Asia/Manila`); branches may override. Business-day logic (e.g., "today's appointments", daily reports) is computed in the branch timezone on the server.
- Calendar-only values (birth date) are `YYYY-MM-DD` strings.

### 7.7 Representative endpoints (not exhaustive)

```
# Auth (public unless noted)
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout                      (auth)
POST   /api/v1/auth/logout-all                  (auth)
POST   /api/v1/auth/switch-tenant               (auth, no tenant required)
POST   /api/v1/auth/password/forgot
POST   /api/v1/auth/password/reset
POST   /api/v1/auth/email/verify

# Current user (auth, no tenant required)
GET    /api/v1/me
PATCH  /api/v1/me
POST   /api/v1/me/password
GET    /api/v1/me/memberships
GET    /api/v1/me/sessions
DELETE /api/v1/me/sessions/:sessionId

# Tenant (active tenant)
GET    /api/v1/tenant
PATCH  /api/v1/tenant
GET    /api/v1/branches
POST   /api/v1/branches
PATCH  /api/v1/branches/:branchId

# Members, invitations, roles
GET    /api/v1/members
PATCH  /api/v1/members/:membershipId            (status, roles)
POST   /api/v1/invitations
POST   /api/v1/invitations/:invitationId/resend
POST   /api/v1/invitations/accept               (public, token in body)
GET    /api/v1/roles
GET    /api/v1/permissions

# Clinic operations
GET    /api/v1/patients?q=…
POST   /api/v1/patients
GET    /api/v1/patients/:patientId
GET    /api/v1/patients/:patientId/encounters
POST   /api/v1/appointments
POST   /api/v1/appointments/:appointmentId/cancel
POST   /api/v1/encounters/:encounterId/finalize
POST   /api/v1/encounters/:encounterId/prescriptions

# Platform administration
POST   /api/v1/admin/tenants
PATCH  /api/v1/admin/tenants/:tenantId/status
PATCH  /api/v1/admin/users/:userId/status
```

### 7.8 Swagger

- Every controller has `@ApiTags`; every DTO property documented (`@ApiProperty`) with examples; error responses documented using the shared error schema.
- The generated OpenAPI JSON (`/api/docs-json`) is **the contract** the frontend consumes; it is exported to the repo on CI so contract changes are visible in review.

### 7.9 Backend support for older, non-technical end users

The backend cannot design UI, but it can make simple, forgiving workflows possible:
- Stable error codes with field-level detail so the frontend can show precise, friendly guidance.
- Idempotent submissions so repeated taps never create duplicates.
- Lenient input normalization (trim whitespace, case-insensitive email, flexible phone formats normalized server-side).
- Typo-tolerant patient search.
- Sessions long enough to avoid frequent re-login, with admin-assisted invitation/reset flows.
- Compact, task-oriented endpoints (e.g., "today's appointments for my branch") to avoid client-side data stitching.

---

## 8. Security Standards

> Data-privacy notes reference the Philippine Data Privacy Act of 2012 (RA 10173) and its IRR as design inputs. **This is not legal advice**; requirements must be confirmed with a qualified privacy/legal professional and the clinic's Data Protection Officer.

1. **Password security** — Argon2id (OWASP baseline, e.g., m=19 MiB, t=2, p=1, tuned on target hardware); min length 10, max 128; check against a common-password list; no composition rules that hurt usability; rehash on login when parameters change.
2. **JWT security** — short TTL, secret ≥ 256 bits from env, explicit algorithm allow-list, validate `exp`/`iat`; no sensitive data in claims.
3. **Refresh token rotation** — opaque, hashed at rest, rotated on every use, family revocation on reuse.
4. **Token revocation** — session-backed; logout, password change/reset, account deactivation, and membership removal take effect on the next request.
5. **Tenant isolation** — §3 three-layer model; cross-tenant access returns 404 and is logged as a security event.
6. **Authorization checks** — deny-by-default permissions guard; resource-level policies in services.
7. **Input validation** — global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`); max lengths on all strings; request body size limit; UUID param validation.
8. **SQL injection prevention** — Prisma parameterized queries only; `$queryRawUnsafe` forbidden (lint rule); tagged `$queryRaw` with reviewed parameters only.
9. **Rate limiting & brute force** — global throttling; stricter limits on `login`, `refresh`, `password/forgot`, `invitations/accept`; per-account progressive delay/temporary lock after repeated failures (with limits to avoid lockout-as-DoS); all failures audited.
10. **CORS** — explicit allow-list of frontend origins from config; credentials only for those origins; no wildcard in production.
11. **Secrets management** — env vars only, validated at startup; `.env` git-ignored (already); production secrets in the host's secret manager; separate secrets per environment; key rotation procedure documented.
12. **Sensitive data handling** —
    - Classify data: public / internal / personal / **sensitive personal (health)**.
    - `password_hash` and token hashes globally omitted from Prisma results; explicit response DTOs/mappers (never return Prisma entities directly).
    - **No PHI in logs, traces, or error messages**: request/response bodies are not logged; Observe instrumentation configured to redact; identifiers only.
    - TLS in transit; encryption at rest via the managed PostgreSQL provider; field-level encryption for selected fields evaluated later.
    - Data minimization: collect only what workflows need.
13. **Audit logging** — append-only `audit_logs` (actor user + membership, tenant, action, entity type/id, timestamp, IP, request id, changed-field names; values only where non-sensitive). Covers auth events, membership/role changes, all clinical and financial mutations, and **reads of medical records** (access logging). The app DB role has no `UPDATE`/`DELETE` on `audit_logs`.
14. **Data retention and deletion** — retention periods per data class defined with the clinic/legal (medical records typically have long retention obligations — to be confirmed, Q7). Data subject requests (access, correction, erasure where lawful) supported via admin export/correction tools; erasure of clinical data constrained by retention duties.
15. **Breach readiness** — security events (cross-tenant attempts, token reuse, brute force) surfaced as Observe alerts; documented incident response including the NPC notification timeline (understood to be 72 hours — confirm).
16. **Secure error handling** — global exception filter maps known errors (Prisma `P2002` → 409, `P2025` → 404, validation → 400) to the standard shape; unknown errors → generic 500 with `requestId`; details only in server logs (PHI-free).
17. **HTTP hardening** — `helmet`, `trust proxy` configured correctly for real client IPs, no `X-Powered-By`.
18. **Dependency hygiene** — lockfile committed, `npm audit` in CI, no pre-release packages in production paths (relevant to Q1).

---

## 9. NestJS Code Organization

### 9.1 Directory layout

```
src/
  main.ts                      # bootstrap: prefix, versioning, pipes, helmet, CORS, swagger
  app.module.ts
  config/                      # env schema validation + typed config namespaces
  common/
    decorators/                # @Public, @TenantNotRequired, @RequirePermissions, @PlatformAdmin, @CurrentContext
    guards/                    # JwtAuthGuard, PermissionsGuard, PlatformAdminGuard
    filters/                   # GlobalExceptionFilter
    interceptors/              # (minimal: e.g., audit/timing only if needed)
    middleware/                # request id
    dto/                       # PaginationQueryDto, shared response wrappers
    errors/                    # error code catalog + DomainError classes
    utils/
  prisma/                      # PrismaService (raw, restricted), TenantPrismaService (scoped extension)
  context/                     # RequestContext (AsyncLocalStorage)
  modules/
    health/
    audit/
    auth/                      # login, tokens, sessions, password flows
    users/                     # global profile, platform account admin
    tenants/                   # tenant lifecycle, onboarding
    tenancy/                   # TenantGuard, membership resolution
    branches/
    members/                   # memberships + invitations
    access-control/            # roles, permissions, policies
    patients/
    practitioners/
    appointments/
    clinical/                  # encounters, notes, diagnoses, prescriptions
    services-catalog/
    billing/                   # invoices, payments
    notifications/
    reports/
    admin/                     # platform admin endpoints
prisma/
  schema/                      # multi-file schema by domain
  migrations/
  seed/
test/                          # e2e + isolation suites, factories, test DB helpers
docs/
```

### 9.2 Conventions

| Element | Convention |
|---|---|
| Modules | One per bounded domain; export only services other modules legitimately need. No circular imports; shared needs go to `common/` or an explicit service. |
| Controllers | Thin: routing, DTO binding, decorators, response mapping. No Prisma, no business rules. |
| Services | Business logic, transactions, policies, audit calls. Use the tenant-scoped client in domain modules. |
| Repositories | Only where queries become complex or raw SQL is needed; otherwise services use Prisma directly (boring > clever). |
| DTOs | `CreateXDto`, `UpdateXDto`, `XQueryDto`, `XResponseDto`; `class-validator` + `@ApiProperty`; response DTOs built by explicit mapper functions. |
| Guards | Global, in the order in §5.2. |
| Decorators | Metadata only; no logic. |
| Interceptors | Kept minimal; no hidden response rewriting beyond the `{ data }` envelope if adopted globally. |
| Middleware | Request id, security headers. Not used for auth or tenancy. |
| Exception filters | One global filter producing the standard error shape. Domain code throws `DomainError(code, status)`. |
| Prisma integration | Single `PrismaService` (lifecycle hooks, pg driver adapter); tenant-scoped extension exposed as `TenantPrismaService`. Prisma errors never escape to the client unmapped. |
| Configuration | `@nestjs/config`, namespaced (`app`, `db`, `auth`, `cors`, `mail`), validated at boot; no `process.env` outside `config/`. |
| Logging | Nest `Logger` (JSON in production), correlated by Observe; request id on every log line; PHI-free. |
| ESM | `.js` suffix on relative imports; `import.meta.dirname`; Vitest `vi.fn()`. |
| Tests | `*.spec.ts` next to the code; `*.e2e-spec.ts` under `test/`. |

---

## 10. Development Phases and Milestones

Order adjustments vs. the requested outline (with reasons):
- **Audit log foundation moves to Phase 2.** Auth, membership, and role events must be audited from the first day they exist; retrofitting is error-prone. Phase 6 keeps audit *query/reporting* APIs.
- **Phase 2 includes a minimal `users` table** because memberships reference users; full auth flows remain in Phase 3. Phase 2 tests use a test-only token helper.
- **Services catalog moves to Phase 5** because appointments and encounters reference services.

### Phase 1 — Project Foundation
- **Objectives:** A runnable, configured, conventional skeleton connected to PostgreSQL.
- **Deliverables:** Prisma version decision applied (Q1) with matched CLI/client; PostgreSQL for local dev (Docker Compose) and a separate test DB; `PrismaService`; `@nestjs/config` with validated env; global prefix `/api` + URI versioning; global `ValidationPipe`; global exception filter + error code catalog; request id middleware; helmet + CORS from config; Swagger at `/api/docs`; health endpoints; Observe PHI-redaction configured; DB roles (owner vs app); lint rules (no `process.env` outside config, no `$queryRawUnsafe`); CI running lint, typecheck, unit, e2e against Postgres; remove the default "Hello World" controller.
- **Dependencies:** Q1, Q4.
- **Key decisions:** Prisma version; Express kept; error/response shape; multi-file Prisma schema.
- **Done when:** `npm run start:dev` boots against Postgres; invalid env fails fast; `/api/health/ready` checks DB; Swagger renders; CI is green; a deliberate error returns the standard error shape without internals.

### Phase 2 — Multi-Tenancy Foundation (`plans/01-multitenancy.md`)
- **Objectives:** Tenancy data model and automatic, enforced tenant isolation.
- **Deliverables:** `users` (minimal), `tenants`, `branches`, `tenant_memberships`, `invitations` schema; composite-FK pattern and conventions; `RequestContext` (AsyncLocalStorage); `TenantGuard`; tenant-scoped Prisma extension + tenant-owned model registry; route-category decorators; tenant onboarding transaction (platform-admin provisioned); tenant status lifecycle; branch CRUD; `audit_logs` table + `AuditService`; isolation test harness with two seeded tenants.
- **Dependencies:** Phase 1.
- **Key decisions:** tenant-in-session model; RLS deferred with role separation in place; composite FKs mandatory.
- **Done when:** A query on a tenant-owned model without context throws; cross-tenant reads/writes on branches return 404 in tests; composite FKs reject cross-tenant references at the DB level (tested with raw inserts); onboarding creates tenant + branch + roles + owner atomically and is audited.

### Phase 3 — Authentication (`plans/02-authentication.md`)
- **Objectives:** Secure global identity and sessions.
- **Deliverables:** Argon2id hashing; login; access JWT; sessions with refresh rotation + reuse detection; logout / logout-all; switch-tenant; `GET /me`; email verification; forgot/reset password; change password; session listing/revocation; invitation acceptance (new + existing users); login throttling and lockout; mail sending via outbox; scheduled cleanup of expired tokens/sessions; auth events audited.
- **Dependencies:** Phase 2; Q3, Q5, Q6.
- **Key decisions:** token lifetimes; refresh token transport; registration policy.
- **Done when:** All flows covered by e2e tests including token reuse, expired/revoked sessions, and enumeration-safe responses; password change/reset revokes sessions; switch-tenant refuses non-members.

### Phase 4 — User Management & Authorization (`plans/03-user-management-and-authorization.md`)
- **Objectives:** RBAC and member administration within tenants.
- **Deliverables:** Permission catalog + seeding; role templates materialized per tenant; `role_permissions`, `membership_roles`; `PermissionsGuard` (deny-by-default) + `@RequirePermissions`; resource-policy pattern; member listing, role assignment, suspension/removal with last-owner invariant; invitations management; global profile management; platform admin endpoints (tenants, user status); route-registry test.
- **Dependencies:** Phase 3.
- **Key decisions:** roles tenant-owned, permissions code-defined; custom role editing deferred; platform admins have no implicit clinical data access.
- **Done when:** Each default role's permission matrix is tested; every tenant-scoped route declares permissions (enforced by test); permission/role changes apply on the next request; removing a member immediately blocks their access.

### Phase 5 — Core Clinic Management APIs (`plans/04-core-clinic-apis.md`)
- **Objectives:** Daily clinical workflows.
- **Deliverables:** Patients (create, search, update, archive; tenant-unique patient number); practitioner profiles; staff directory (from memberships); services catalog; appointments (booking, rescheduling, cancel, check-in, no-show; double-booking exclusion constraint; idempotent creation; branch-timezone "today" queries); encounters with notes, vitals, diagnoses (ICD-10), finalize + amend; prescriptions; medical-record access logging; optimistic locking.
- **Dependencies:** Phase 4; Q8 (clinical/prescription rules with domain experts).
- **Key decisions:** patients are per-tenant records; no doctors/staff duplication; immutable finalized clinical records.
- **Done when:** Full isolation matrix passes for every new resource; double booking is impossible under concurrent requests; finalized encounters cannot be edited, only amended; all clinical reads/mutations are audited.

### Phase 6 — Additional Clinic Operations (`plans/05-additional-clinic-apis.md`)
- **Objectives:** Money, communication, and insight.
- **Deliverables:** Invoices (from encounters/services), invoice items, discounts, payments (partial, void, refund), idempotent payment recording; notifications (appointment reminders via scheduled jobs + outbox; email first, SMS later); operational reports (daily appointments, revenue by branch/period, computed in tenant timezone); audit log query API for tenant admins; tenant data export.
- **Dependencies:** Phase 5; Q6, Q8.
- **Key decisions:** money as `numeric`; financial immutability; no Redis until volume justifies it.
- **Done when:** Invoice balances always equal items minus payments (tested, including concurrency); reminders are sent exactly once per appointment; reports match seeded fixtures; audit logs are queryable by authorized roles only.

### Phase 7 — Testing Hardening & Production Readiness
- **Objectives:** Confidence to handle real patient data.
- **Deliverables:** Coverage gaps closed; full tenant-isolation and authorization matrices; security tests (§11.7); RLS spike on clinical tables with measured overhead and a go/no-go recommendation; load tests on hot endpoints (login, patient search, appointment listing); Dockerfile; production config review; migration pipeline (`migrate deploy`); backups + point-in-time recovery verified by a restore drill; Observe alerts (error rate, latency, security events); runbooks; privacy documentation support (data inventory, retention schedule).
- **Dependencies:** Phases 1–6; Q4.
- **Done when:** All suites green in CI; restore drill succeeds; no critical/high vulnerabilities open; p95 latency targets met (to be set in the child plan); security checklist signed off.

> Testing is **continuous**, not deferred to Phase 7: every phase ships unit, integration, and isolation tests for what it adds.

---

## 11. Testing Strategy

### 11.1 Layers

| Layer | Tooling | What |
|---|---|---|
| Unit | Vitest, `vi.fn()` | Pure logic: policies, token utilities, mappers, validators, state machines. No DB. |
| Integration | Vitest + real PostgreSQL test DB | Services + Prisma against a migrated schema: constraints, composite FKs, exclusion constraints, transactions, the tenant extension. **No mocking of Prisma for data-access behavior.** |
| E2E API | Vitest + supertest + `Test.createTestingModule` | Full HTTP stack: guards, validation, error shapes, status codes. |

### 11.2 Database testing
- Dedicated test database; migrations applied once per run; tables truncated between test files (or per-test transactions where feasible).
- Factories create tenants, users, memberships, and domain records with explicit tenants.
- Constraint tests insert invalid rows directly to prove the database itself rejects them.

### 11.3 Authentication testing
Valid/invalid login, generic errors, lockout and throttling, expired/tampered/wrong-algorithm JWTs, refresh rotation, refresh reuse → family revoked, logout effectiveness, password change/reset revoking sessions, reset token single use and expiry, enumeration-safe forgot-password, deactivated user cannot log in or refresh.

### 11.4 Authorization testing
Table-driven matrix: role × endpoint → expected status. Deny-by-default (route without permission metadata fails the registry test). Resource-level policies (e.g., a nurse cannot finalize an encounter; a doctor cannot amend another doctor's draft). Permission revocation effective on next request. Platform admin cannot read clinical data through tenant routes.

### 11.5 Multi-tenant isolation testing (highest priority)

Fixture: **Clinic A** and **Clinic B**, each with an owner, a doctor, a receptionist, patients, appointments, encounters, invoices. Plus **user M** who is a member of both with different roles.

For every tenant-scoped resource, an automatically generated suite verifies, as a Clinic A user:

| Attempt | Expected |
|---|---|
| List resources | Only Clinic A records; Clinic B records never appear (including via search, filters, pagination totals, reports). |
| `GET` a Clinic B record by id | `404`; no data in body. |
| `PATCH`/`PUT` a Clinic B record | `404`; Clinic B row unchanged in DB. |
| `DELETE`/archive/action (`cancel`, `finalize`, `void`) on a Clinic B record | `404`; Clinic B row unchanged. |
| Create a record referencing a Clinic B id (e.g., appointment with Clinic B `patientId`) | `404`/`422`; and the composite FK rejects it even if the service check is bypassed. |
| Send `tenantId` of Clinic B in body/query/header | Ignored or rejected (`forbidNonWhitelisted`); context remains Clinic A. |
| `switch-tenant` to Clinic B without membership | `403`. |
| Membership in Clinic A removed while access token still valid | Next request `403`. |
| User M switches A → B | Sees only B data with B-role permissions; A-role permissions do not carry over. |
| Concurrent requests from users of A and B | No context bleed (AsyncLocalStorage correctness under parallel load). |
| Nested includes / relation filters | Related records from B never returned. |
| Audit logs & reports | A's admin cannot see B's audit entries or figures. |

Plus a **static registry test**: every tenant-owned Prisma model is registered with the tenant extension, has `tenant_id`, `@@unique([tenantId, id])`, and composite FKs for tenant-owned relations.

### 11.6 Architecture guard tests
- Every route is exactly one of: public, tenant-not-required, tenant-scoped (with permissions), platform-admin.
- Domain modules do not inject the raw `PrismaService`.
- No `$queryRawUnsafe` usage.

### 11.7 Security testing
Injection payloads in search/filter params, oversized payloads, mass-assignment attempts (extra fields like `role`, `tenantId`, `status`), CORS behavior, rate-limit behavior, error responses free of stack traces/SQL, logs free of PHI (assert on captured logs for clinical routes), dependency audit.

### 11.8 Performance testing
Seeded realistic volumes (multiple tenants, tens of thousands of patients/appointments) to validate indexes (`EXPLAIN` on hot queries) and p95 latency targets.

---

## 12. Documentation Standards

Kept in `docs/`, short and maintained alongside code (a PR changing behavior updates the doc):

| Document | Contents |
|---|---|
| `docs/architecture.md` | Module map, request lifecycle (guards order), key decisions. |
| `docs/adr/NNNN-*.md` | Architecture Decision Records (one page each): Prisma version, tenant-in-session, RLS deferral, token strategy, etc. |
| `docs/multitenancy.md` | Tenant model, context propagation, isolation layers, how to add a tenant-owned model safely (checklist). |
| `docs/authentication.md` | Token/session lifecycle with sequence diagrams (Mermaid): login, refresh rotation, reuse detection, switch tenant, password reset. |
| `docs/authorization.md` | Permission catalog, default role matrix, policy pattern. |
| `docs/database.md` | Conventions (§6), ERD (Mermaid, generated from Prisma schema), global vs tenant-owned tables, retention per table. |
| `docs/api-conventions.md` | §7 in reference form. |
| `docs/error-codes.md` | Stable error code catalog. |
| OpenAPI | Generated by `@nestjs/swagger`; exported `openapi.json` committed by CI. The API contract for the frontend. |
| `docs/environment.md` | Required env vars, local setup (Docker Compose Postgres), seeding, running tests. |
| `docs/deployment.md` | Build, migrate, release, rollback, backups/restore, secrets, monitoring/alerts. |
| `docs/security-privacy.md` | Data classification, logging rules, audit coverage, retention, incident response (not legal advice). |
| `README.md` | Replace the default Nest README with project-specific quick start and links. |

---

## 13. Required vs Future Enhancements

| Required (Phases 1–7) | Future enhancements |
|---|---|
| Shared-schema tenancy with three-layer isolation | PostgreSQL RLS (pending Phase 7 spike) |
| Default roles per tenant, code-defined permissions | Tenant-defined custom roles API |
| Platform-admin tenant provisioning | Self-service clinic signup |
| Email/password auth, sessions, refresh rotation | MFA (TOTP) — strongly recommended for owners/admins soon after launch; SSO |
| Email notifications | SMS reminders (provider TBD), push |
| Per-tenant patient records | Patient portal / patient login; duplicate-patient merge |
| Membership-level access across all branches | Branch-restricted memberships |
| Offset/cursor pagination, trigram search | Full-text search engine (only if Postgres proves insufficient) |
| Audit logs | Tamper-evident (hash-chained) audit logs |
| In-process jobs with outbox | Redis/BullMQ queues (only when volume requires) |
| Basic reports | Analytics, PhilHealth claims integration, lab/HL7/FHIR integrations |

---

## 14. Risks and Trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| Prisma 8 RC + Prisma 7 client mismatch | Build/runtime breakage; unstable APIs under PHI workloads | Resolve in Phase 1 (Q1); pin exact versions. |
| Missed tenant filter in app code | Cross-tenant data leak (severe) | Scoped Prisma extension, composite FKs, registry + isolation tests, raw SQL review. |
| Prisma extension coverage gaps (nested writes, raw queries) | Partial bypass | Composite FKs as hard backstop; documented coverage; tests per operation type. |
| Per-request session/membership lookup | Extra DB query per request | Single indexed query; short in-request caching; measure in Phase 7. |
| One active tenant per session | Users in two clinics must switch | Acceptable; switching is one call; revisit if needed. |
| In-memory throttling | Ineffective when horizontally scaled | Document; move to shared store when scaling. |
| PHI leaking into logs/telemetry | Privacy breach | No body logging, redaction config, log-assertion tests. |
| Long refresh lifetimes | Larger window if a device is stolen | Rotation, reuse detection, session listing/revocation, admin can suspend membership. |
| First-party NestJS 12 packages not yet verified | Plan assumptions may not match package APIs | Verify in each child plan before adoption; fall back to direct guards. |
| Regulatory interpretation | Non-compliance | Legal/DPO review; documented data inventory and retention schedule. |

---

## 15. Open Questions Requiring Approval

1. **Prisma version.** Recommended: pin **stable Prisma 7.x** for both `prisma` and `@prisma/client` (plus `@prisma/adapter-pg`), rewriting `prisma.config.ts` to the v7 shape, and revisit Prisma 8 after GA. Alternative: adopt Prisma 8 RC fully (new `contract.prisma`/`orm` config, `@prisma/orm-postgres`). I could not verify the Prisma 8 ORM APIs because its ORM skill isn't installed here.
2. **RLS timing.** Recommended: defer to a Phase 7 spike (with DB role separation from Phase 1). Approve, or require RLS on clinical tables from Phase 5?
3. **Onboarding and registration.** Recommended: platform-admin-provisioned tenants and invitation-only staff accounts at launch; public self-registration disabled. Approve?
4. **Hosting and data location.** Which provider / region for the API and managed PostgreSQL? (Affects backups, PITR, secrets, and cross-border data transfer considerations.)
5. **Refresh token transport.** Will the frontend be served from the same site (e.g., `app.doctayo.ph` + `api.doctayo.ph`) so httpOnly cookies work? If not, refresh tokens must be returned in the body and stored by the client.
6. **Email and SMS providers.** Which transactional email provider? Is SMS required at launch (likely valuable for older patients' reminders)?
7. **Retention periods.** What retention periods apply to medical, financial, and audit records? (Needs clinic/legal input.)
8. **Domain rules.** Need clinician/clinic-owner input on prescription requirements, ICD-10 usage, Senior Citizen/PWD discount handling, PhilHealth needs, and appointment rules (walk-ins, slot lengths).
9. **Doctors without accounts.** Must the system record practitioners who never log in (e.g., visiting doctors)? Current design assumes every practitioner is a member user.
10. **MFA.** Should MFA for owners/administrators be in scope before go-live rather than a post-launch enhancement?
