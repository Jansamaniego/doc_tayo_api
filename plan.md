# DocTayo Backend — Master Development Plan

> **Scope:** Backend only (`doc-tayo-api`). The frontend has its own independent plan. This document only describes API contracts the frontend will consume, never frontend implementation.
>
> **Status:** Phases 1 (Project Foundation) and 2 (Multi-Tenancy Foundation) are **implemented**; Phases 3–7 are still plan-only and require approval of their child plans before implementation. This document was last aligned with the codebase after Phase 2 (see §0; per-phase deviations are recorded in each child plan's "As Built" section).
>
> **Sync rule:** this plan and the child plans describe the code **as it is**. Whenever implemented code differs from a plan, the plan is edited in the same change (see `CLAUDE.md`, "Plans and docs stay aligned with the code").
>
> **Child plans** (must stay consistent with this document):
> `plans/00-project-foundation.md` (Phase 1, implemented) · `plans/01-multitenancy.md` (Phase 2, implemented) · `plans/02-authentication.md` (Phase 3, implemented) · `plans/03-user-management-and-authorization.md` · `plans/04-core-clinic-apis.md` · `plans/05-additional-clinic-apis.md` (03–05 not written yet)

---

## 0. Current State of the Project

The Phase 1 foundation is in place. Everything below was verified against the repository, not assumed.

| Area | Current state | Implication |
|---|---|---|
| Framework | NestJS `12.x`, `@nestjs/platform-express` | Express kept. `NodeAdapter` is faster but not needed now. |
| Module system | ESM (`"type": "module"`, `nodenext`), Node `>=24` (`.nvmrc` = 24) | Relative imports end in `.js`; use `import.meta.dirname`. |
| Language | TypeScript 6, `strict: true` (`noImplicitOverride` and `noUncheckedIndexedAccess` enabled in Phase 2, ADR-0002 amended) | Done (plans/01-multitenancy.md D6). |
| Tests | Vitest 4: unit (`src/**/*.spec.ts`, `test/architecture/**`) and e2e (`test/**/*.e2e-spec.ts`, real PostgreSQL), supertest | Mocks are `vi.fn()`. No Jest. |
| Lint/format | oxlint (type-aware) + Prettier. **ESLint is not used** (ADR-0006) | Rules oxlint cannot express live in `test/architecture/forbidden-patterns.spec.ts`. |
| ORM | **Prisma `7.10.1` pinned exactly** for `prisma`, `@prisma/client` and `@prisma/adapter-pg` (ADR-0001). Prisma 8 RC removed | Do not run `npm i prisma@latest` (it installs the 8 RC). |
| Prisma layout | `prisma.config.ts` (Prisma 7 `defineConfig`; datasource URL = `DATABASE_MIGRATION_URL`, loads `.env` itself); schema folder `prisma/schema/` (`base.prisma`, `identity.prisma`, `tenancy.prisma`, `audit.prisma`); migrations `tenancy_foundation` (Phase 2) and `authentication` (Phase 3, also creates the `nest_outbox` schema); generated client in `src/generated/prisma` (gitignored) | Phase 2 added the tenancy models, Phase 3 the credential, session and invitation models. |
| Database | PostgreSQL 17. Roles: `doctayo_owner` (migrations), `doctayo_app` (runtime, DML only, `NOBYPASSRLS`). `scripts/db/bootstrap.sql` is idempotent. `PrismaService` fails fast on connect and refuses to start in production if its role is a superuser or bypasses RLS | Role separation (needed for a future RLS option) exists from day one. |
| Config | `src/config` validates every env var at boot with `class-validator` and exposes typed namespaces `app`, `database`, `cors`, `logging`, `swagger`, `observe`, `auth`, `mail`. `JWT_ACCESS_SECRET` is required in every environment. Only `src/config` and tests may touch `process` (lint rule) | The app refuses to start on invalid config; errors name variables, never values. |
| HTTP foundation | `app.setup.ts` applies request id, access log, Helmet, CORS, 1 MB JSON limit, global prefix `api` + URI versioning (default `v1`), global `ValidationPipe`, `AllExceptionsFilter`, Swagger, shutdown hooks. `main.ts` and the e2e tests share it | Tests exercise the real stack. |
| Errors | One envelope `{ error: { status, code, message, details?, requestId } }`, stable code catalog (`src/common/errors/error-codes.ts`, `docs/error-codes.md`), `DomainError`. Active since Phase 2: `UNAUTHENTICATED`, `FORBIDDEN`, `TENANT_NOT_SELECTED`, `TENANT_SUSPENDED`, `TENANT_DEACTIVATED`, `TENANT_ACCESS_DENIED`. `CONFLICT` is produced by the tenant lifecycle service and invitations. Added in Phase 3: `INVALID_CREDENTIALS`, `ACCESS_TOKEN_EXPIRED`, `TOKEN_INVALID`, `ROLE_NOT_ASSIGNABLE` and the field codes `PASSWORD_TOO_COMMON`, `PASSWORD_CONTAINS_EMAIL`, `PASSWORD_INCORRECT`. `RATE_LIMITED` (429) comes from the throttler (mapped from its 429) and from account lockout (a `DomainError` with `Retry-After`); `METHOD_NOT_ALLOWED` (405) is only mapped from framework exceptions | Success envelopes (`{ data }`, `{ data, meta }`) are returned explicitly by controllers; no global wrapping interceptor (ADR-0005). |
| Observability | `@nestjs/observe` configured with PHI redaction, request-body capture off, header allow-list, query strings obfuscated, `forwardLogs` off. Request ids are server-validated UUIDs (ADR-0004) | Observe is enabled by default only in production. |
| Health | `GET /api/health` (liveness, no dependencies) and `GET /api/health/ready` (real `SELECT 1`, 1 s timeout, up/down only), version-neutral, via `@nestjs/terminus` | `@Public()` (Phase 2), so it stays reachable under the deny-by-default guards. |
| Docker | Multi-stage `Dockerfile` (`runtime` and `migrate` targets, non-root, `HEALTHCHECK`); a single local Compose stack (`api`, `postgres`, one-off `migrate`); CI builds both targets | See §2.1. |
| CI | GitHub Actions: lint, format check, typecheck, unit tests, bootstrap DB, `migrate deploy`, e2e against Postgres 17, build, informational `npm audit`, Docker build | |
| Domain code | Tenancy foundation (Phase 2): tenants, memberships, roles, branches, audit, request context, guards (`AuthGuard` -> `TenantGuard` -> `PermissionsGuard`), `TenantPrismaService`. Authentication (Phase 3): Argon2id passwords, access JWT + server-side sessions with rotated refresh cookies, login/refresh/logout/switch-tenant, password reset/change, account setup, invitations, throttling and lockout, mail through the transactional outbox, nightly cleanup, audited auth events; the production authenticator is `JwtAuthenticator`. No clinic data | Phase 4 adds member management and the platform-admin API. |
| Installed in Phase 3 | `@nestjs/jwt`, `argon2`, `@nestjs/throttler`, `@nestjs/schedule`, `cookie-parser`, and (pinned exactly, both 0.x) `@nestjs/mail` 0.0.2 and `@nestjs/outbox` 0.1.4 | Mail and outbox are confined to `modules/mail` (ADR-0013). |
| Not installed (by design) | Redis, BullMQ, `@nestjs/authentication`, any AWS SDK | Added only in the phase that needs them. |

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
| ORM | Prisma `7.10.1` (pinned) + `@prisma/adapter-pg` | **Installed.** Decision recorded in ADR-0001; revisit Prisma 8 only when GA with matching client and adapter. |
| Database | PostgreSQL 17 (local Compose and CI); any managed PostgreSQL ≥ 15 that allows creating roles | Single database, `public` schema. |
| API docs | `@nestjs/swagger` (**installed**) | OpenAPI 3; served at `/api/docs`; on by default outside production, off in production (`SWAGGER_ENABLED`). |
| Validation | DTOs + `class-validator` / `class-transformer` via global `ValidationPipe` (**installed**) | `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, implicit conversion off. |
| Config | `@nestjs/config` with schema-validated env at startup (**installed**) | App refuses to boot with invalid config. Environment-driven so one image runs in every environment (§2.1). |
| Auth | `@nestjs/jwt` + `argon2` on the existing `Authenticator` seam; `@nestjs/authentication` evaluated and **not adopted** (ADR-0011) | Revisit `@nestjs/authentication` at 1.0, especially for MFA/OIDC. `@nestjs/authorization` is evaluated at Phase 4. |
| Password hashing | Argon2id (`argon2` package) | OWASP-recommended parameters (§8.1). |
| Rate limiting | `@nestjs/throttler` 6.x (**Phase 3, done**) | In-memory store while single-instance; a shared store (for example Redis) only when scaled out and only once Redis is actually adopted. |
| Health checks | `@nestjs/terminus` (**installed**) | `/api/health` (liveness), `/api/health/ready` (DB). |
| Scheduled work | `@nestjs/schedule` (+ `@nestjs/locks` when multi-instance) | Token cleanup, reminders. |
| Async side effects | Transactional outbox (evaluate `@nestjs/outbox`) | Emails/SMS sent after commit. No Redis until justified. |
| Idempotency | Evaluate `@nestjs/idempotency` | For appointment booking and payments. |
| Email | `@nestjs/mail` | Provider TBD (Q6). |
| Observability | `@nestjs/observe` (**installed**) | Redaction and header/body capture rules in `src/observability/observe.ts`. |
| Security headers | `helmet` (**installed**) | Strict CSP; relaxed only on `/api/docs`. HSTS in production only. |

**Explicitly not introduced (and not to be added speculatively):** Redis, message brokers, AWS SDKs or infrastructure-as-code, separate auth database, separate schemas per tenant, GraphQL, microservices, a second ORM.

> Uncertainty: NestJS 12 first-party packages listed in AGENTS.md (`@nestjs/authentication`, `@nestjs/authorization`, `@nestjs/outbox`, `@nestjs/idempotency`, `@nestjs/mail`) were not verified in detail for this plan. Each child plan must confirm the API against https://docs.nestjs.com before adopting it.

### 2.1 Runtime environments and Docker

**One image, configured by environment variables.** The `runtime` image contains no configuration and no secrets; the same image runs locally, in CI and in production. Differences come only from env vars (validated at boot, see `docs/environment.md`).

| | Local development (implemented) | Production (target, not provisioned) |
|---|---|---|
| API | `api` service in Docker Compose, `NODE_ENV=development`, published on `127.0.0.1:3000` | The same image on a container host (for example AWS EC2) with `NODE_ENV=production` |
| PostgreSQL | `postgres` service (`postgres:17-alpine`), reached by the API at `postgres:5432` over the Compose network; data in the named volume `pgdata`; published on `127.0.0.1:5434` for DBeaver | External managed PostgreSQL (for example AWS RDS) supplied through `DATABASE_URL` |
| DB TLS | `DATABASE_SSL=disable` (private Docker network) | `require` or `verify-full` (validation rejects `disable` in production). A provider-specific CA bundle is supplied through Node's `NODE_EXTRA_CA_CERTS`, which needs no code change |
| Migrations | `docker compose run --rm migrate` (one-off job, owner role, waits for a healthy database, never runs on API start) | A separate release step using the `migrate` image with `DATABASE_MIGRATION_URL`. The running API never receives the owner credentials |
| Secrets | Throwaway dev defaults in `docker-compose.yml`, overridable via `DB_OWNER_PASSWORD`, `DB_APP_PASSWORD`, `POSTGRES_SUPERUSER_PASSWORD`; `.env` is gitignored and not used by Compose for the API's database URL | From the host's secret store; never in a Dockerfile, Compose file or Git |
| Other services | None | None yet |

Local Compose services: `api`, `postgres`, `migrate` (profile `tools`, so `up` never runs it). Commands: `docker compose up --build -d`, `docker compose run --rm migrate`, `docker compose down` (keeps data), `docker compose down -v` (**deletes the database volume**). Full guide: `docs/docker.md`; rationale: ADR-0007.

**Redis (future, not implemented).** Nothing in the repository references Redis. If it is adopted (for example for shared rate limiting or queues), the change is additive: a new service in Compose, a new validated connection variable in `src/config`, and an `environment:` entry on `api`; locally it would be reached by service name and in production through a managed endpoint, with no image change. The same applies to any other external dependency. Do not add Redis packages, services or variables before a feature needs them.

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

**As built (Phase 2):** these tables exist: `users`, `permissions`, `tenants`, `branches`, `tenant_memberships`, `roles`, `role_permissions`, `membership_roles`, `audit_logs`. Phase 3 added `sessions`, `refresh_tokens`, `user_tokens` (global) and `invitations` (tenant-owned, a registry model), plus the credential columns on `users`; clinic tables arrive from Phase 5. `audit_logs.tenant_id` is nullable, so `audit_logs` is attributed to a tenant but is **not** in the tenant-owned model registry (audit rows are written through `AuditService`, see §8 item 13).

### 3.3 Tenant context: how a request gets its tenant

**Recommended approach: guard + request-scoped context store (AsyncLocalStorage), not middleware alone.**

1. User logs in → session created.
2. If the user has exactly one active membership, it becomes the active tenant automatically. Otherwise the client calls `POST /api/v1/auth/switch-tenant`.
3. The server verifies an **active membership** in an **active tenant** and records `active_tenant_id` on the session. The change applies to the very next request; **no new token is issued and the access token carries no tenant** (plans/02-authentication.md D5).
4. On every request, `TenantGuard` (runs after authentication):
   - reads the active tenant from the authenticated principal (`sessions.active_tenant_id`, read by `JwtAuthenticator`; never from a body/query/header);
   - re-verifies in one query that the user is `active`, the membership is `active`, and the tenant is not suspended/deactivated (Phase 2: one parameterized `$queryRaw` joining membership, user, tenant and effective permissions; the session itself is re-checked by `JwtAuthenticator`, one indexed query, on every request);
   - loads the membership's effective permissions;
   - stores `{ userId, sessionId, tenantId, membershipId, permissions }` in a `RequestContext` (AsyncLocalStorage).
5. Services and the tenant-scoped Prisma client read the tenant from `RequestContext`. **Tenant id is never a method parameter supplied by controllers.**

**Principal types (portal-ready).** The access token carries a principal-type claim (`staff` or `patient`). Staff principals go through the membership flow above. Patient-portal principals have no membership; they are authorized by `patient_portal_links` and every portal query is filtered to the caller's linked patient ids (row-level ownership, which RBAC cannot express). Each controller group accepts exactly one principal type, so a patient token can never reach staff endpoints and vice versa. The portal itself is a later phase; Phase 2 and 3 only avoid assumptions that would block it.

Why a guard and not middleware: guards run after authentication, have access to route metadata (`@Public()`, `@TenantNotRequired()`), and can return proper 401/403. Middleware is used only for cross-cutting non-auth concerns: request id, security headers, and the `RequestContext` store, whose AsyncLocalStorage middleware is mounted by `TenancyModule` after the body parsers (Node loses the context across body-parser's socket events if it runs earlier). Guards fill that store; the middleware itself decides nothing.

Why tenant-in-token rather than tenant-in-URL or `X-Tenant-Id` header: one source of truth bound to a server-side session, simpler API paths (`/api/v1/patients`), no client-supplied tenant id to validate. Trade-off: one session = one active tenant at a time (separate logins/sessions are needed for simultaneous work in two clinics). Acceptable for the target users.

Route categories (every route must be exactly one — enforced by a test, §11.6):
- `@Public()` — no auth (login, refresh, password reset, health).
- `@TenantNotRequired()` — authenticated, no active tenant needed (`/me`, `/me/memberships`, switch-tenant, create tenant).
- Default — authenticated **and** tenant-scoped.
- `@PlatformAdmin()` — platform operator routes under `/api/v1/admin/*` (**Phase 4**; not implemented yet).

As built in Phase 2: `@Public()`, `@TenantNotRequired()` and `@RequirePermissions(...)`; the default category (tenant-scoped) must declare permissions, otherwise `PermissionsGuard` denies the route (`test/route-registry.e2e-spec.ts`).

### 3.4 Enforcing isolation without relying on developer memory

- **Tenant-scoped Prisma client** (Prisma Client extension): for every model in a registry of tenant-owned models, it injects `tenantId` from `RequestContext` into `where` for reads/updates/deletes and into `data` for creates. If a tenant-owned model is queried with no tenant in context, it **throws**.
- **Unscoped access is explicit**: the raw `PrismaService` is only injectable in an allow-list of modules: today `health`, `tenancy`, `tenants`, `audit`, `access-control`; later `auth`, `users`, `admin`. Domain modules (`branches`, and later `patients`, …) receive only `TenantPrismaService`. `test/architecture/prisma-access.spec.ts` enforces this (§11.6).
- **Unique lookups stay tenant-safe**: the extension adds `tenantId` to the `where` of `findUnique`, `update`, `delete` and `upsert` (Prisma accepts extra non-unique fields in a unique filter; verified in the Phase 2 spike), so a foreign id behaves as not found.
- **`TenantPrismaService` wraps the extended client** and exposes only model delegates and `$transaction`, because the extended client itself would hand out `$queryRaw`. It throws when no tenant is in context, forbids a conflicting or changed `tenantId`, and refuses update/delete on append-only models (`AuditLog`).
- **Composite foreign keys** (§6.4) make cross-tenant references fail at the database even if application code is wrong.
- **Raw SQL** (`$queryRaw`) is allowed only in repositories with explicit `tenant_id` predicates and requires review; a test asserts tenant filtering for each raw query.
- **Known limitation**: Prisma extensions do not rewrite nested writes or relation filters/includes. Mitigation: composite FKs (verified: cross-tenant nested `connect` and scalar creates are rejected by the database) + isolation tests (§11.5). The exact operation coverage is documented in `plans/01-multitenancy.md` §7.2 and `docs/multitenancy.md`.
- **Prisma promises are lazy**: the tenant is read when a query executes, so queries must be awaited inside the request (documented in `docs/multitenancy.md`).

### 3.5 Tenant lifecycle

| Stage | Behavior |
|---|---|
| **Creation / onboarding** | One transaction creates: the owner user (found by normalized email, else created with `status = pending` until the emailed account-setup link sets a password), tenant (`status = active`), default branch (`Main`), the five system roles from templates, owner membership (`active`) and an audit entry. **A service only (`TenantOnboardingService`), no HTTP endpoint** (since Phase 3 it also issues the owner's 7-day setup link, or an ownership notice for an existing account, in the same transaction); the endpoint is `POST /api/v1/admin/tenants` in Phase 4. Initially **provisioned by a platform admin** (controlled pilot); a self-service signup endpoint can be enabled later by config (Q3). |
| **Configuration** | Owner/admin manages profile (name, contact, timezone default `Asia/Manila`), branches, staff invitations, roles. |
| **Membership management** | Invite by email → `invitations` row (hashed token, 7-day expiry) → acceptance creates/activates membership. Statuses: `invited`, `active`, `suspended`, `removed`. Invariant: a tenant always has ≥ 1 active owner; the last owner cannot be removed or demoted. |
| **Switching** | `POST /auth/switch-tenant` (§3.3). Last-used tenant stored on the session for convenience. |
| **Suspension** | `status = suspended` (e.g., non-payment, investigation): active members' tenant-scoped requests return `403 TENANT_SUSPENDED`; non-members get `TENANT_ACCESS_DENIED` (the state is not revealed to them); data untouched. Reversible. Service: `TenantLifecycleService.suspend/reactivate` (audited; no HTTP endpoint in Phase 2; no free-text reason because `audit_logs` stores field names only). |
| **Deactivation** | `status = deactivated` at owner/platform request: access blocked (`403 TENANT_DEACTIVATED`), data export offered, data retained for the retention period (§8.13). One-way in Phase 2. |
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
| Access token | JWT, 15 min TTL, signed with a strong secret (HS256) held only by the API. Claims: `sub` (user id), `sid` (session id), `typ` (`staff`), `iat`, `exp`, `iss` (`doctayo-api`), `aud` (`doctayo`). **No roles, permissions or tenant in the token** — loaded per request so revocations apply immediately. |
| Refresh token | Opaque 256-bit random value. Stored **only as a SHA-256 hash** in `sessions`. |
| Rotation | Each refresh issues a new refresh token and invalidates the old one. |
| Reuse detection | Presenting an already-rotated refresh token revokes the whole session family (likely theft). |
| Lifetimes | Idle timeout 14 days, absolute 30 days (configurable). Chosen to avoid frequent re-login for older users while bounding risk. |
| Per-request session check | `JwtAuthenticator` re-reads the session (joined to its user) on every request: not revoked, idle and absolute expiry not passed, user `active`. This is a separate indexed query from `TenantGuard`'s membership query, because `@TenantNotRequired()` routes need the session check too. Logout, password change/reset and deactivation are effective on the next request. |
| Transport | **httpOnly cookie** (Q5 resolved, ADR-0012): cookie `dt_refresh`, `HttpOnly`, `Secure` (everywhere except development), `SameSite=Strict`, `Path=/api/v1/auth`; the cookie endpoints also require an `Origin` from `CORS_ALLOWED_ORIGINS`. The access token is in the JSON body and held in memory by the client. Requires `CORS_ALLOW_CREDENTIALS=true`. |

### 4.3 Account flows

| Flow | Endpoint (representative) | Key rules |
|---|---|---|
| Account creation | Via invitation acceptance or tenant onboarding; public self-registration **off by default** (Q3) | Email normalized (trimmed, lowercased) and unique. |
| Email verification | `POST /auth/email/verify` (**deferred to Phase 4**, plans/02 D6) | Nothing produces verification tokens until email change (Phase 4) or self-registration. Consuming an emailed invitation, setup or reset token already marks the email verified. |
| Login | `POST /auth/login` | Generic failure message (`INVALID_CREDENTIALS`); throttled (§8.9). Response includes the user's memberships so the client can choose a tenant. |
| Refresh | `POST /auth/refresh` | Rotation + reuse detection. |
| Logout | `POST /auth/logout` | Revokes current session. |
| Logout everywhere | `POST /auth/logout-all` | Revokes all user sessions. |
| Switch tenant | `POST /auth/switch-tenant` | Verifies membership (the same rule as `TenantGuard`); stores the tenant on the session; effective on the next request, no new token. |
| Current user | `GET /me` | Profile + active tenant + effective permissions in that tenant. |
| Profile | `PATCH /me` (**Phase 4**) | Global profile fields only (name, phone). Email change requires re-verification. |
| Change password | `POST /me/password` | Requires current password; revokes all other sessions. |
| Forgot password | `POST /auth/password/forgot` | Always returns `202` (no account enumeration). Single-use hashed token, 30 min expiry. |
| Reset password | `POST /auth/password/reset` | Consumes token, revokes all sessions. |
| Sessions | `GET /me/sessions`, `DELETE /me/sessions/:id` | Device/IP/last-used metadata. Revoking another user's session id is `404`. |
| Account setup | `POST /auth/account/setup` | First password for an onboarded `pending` owner, from a single-use 7-day emailed link. |
| Invitations | `POST /invitations`, `POST /invitations/:id/resend`, `POST /invitations/accept` | Create/resend need `members.invite`; accept is public (the token is the credential). Listing and revocation: Phase 4. |
| Activation/deactivation | Platform admin: `PATCH /admin/users/:id/status` | Deactivated users cannot log in; all sessions revoked. Tenant admins suspend **memberships**, not global accounts. |
| Assisted reset | Tenant admin can re-send an invitation/reset email for a member | Supports staff who struggle with self-service; admin never sees or sets passwords. |

---

## 5. Authorization (RBAC)

### 5.1 Model

- **Permissions** — a global, code-defined catalog (`src/modules/access-control/catalog.ts`; rows inserted by the migration that introduces a key, checked against the table by a test; not user-editable), keyed as `resource.action`. **Phase 2 catalog (four keys): `tenant.read`, `tenant.settings.manage`, `branches.read`, `branches.manage`**; each later phase appends its own. Target catalog: `patients.read`, `patients.write`, `medical_records.read`, `medical_records.write`, `prescriptions.issue`, `appointments.manage`, `billing.manage`, `members.manage`, `roles.manage`, `branches.manage`, `audit_logs.read`, `tenant.settings.manage`…
- **Roles** — **tenant-owned**. On tenant creation, default roles are created from code-defined templates: Clinic Owner, Clinic Administrator, Doctor, Nurse, Receptionist. Roles have `is_system` (template-derived; protected from deletion) and a stable `key` (`owner`, `clinic_admin`, `doctor`, `nurse`, `receptionist`). Phase 2 templates: owner and clinic_admin hold every permission; doctor, nurse and receptionist hold read-only permissions.
- **Role permissions** — `role_permissions (tenant_id, role_id, permission_id)`.
- **Membership roles** — `membership_roles (tenant_id, membership_id, role_id)`. Roles attach to the membership (user-in-tenant), which is how "different roles in different tenants" works. This replaces the proposed `user_roles` table.
- **Platform (global) roles** — minimal: a `platform_role` enum on `users` (`none`, `platform_admin`; `support` not added). The column exists since Phase 2; nothing reads it until Phase 4. Platform admins manage tenants and accounts via `/api/v1/admin/*`; they do **not** automatically get access to tenant clinical data.
- **Custom roles** — the schema supports tenant-defined roles from day one; the **API for creating/editing custom roles is a future enhancement**. Initially tenants assign the default roles only.

### 5.2 Enforcement in NestJS

Global guard order:

1. `ThrottlerGuard` — rate limits apply before authentication (§8 item 9).
2. `AuthGuard` — asks the pluggable `Authenticator` for the principal; skipped for `@Public()`. The production binding is `JwtAuthenticator` (session re-verified on every request); tests may bind `TestAuthenticator` from `test/support/`.
3. `TenantGuard` — membership/tenant validation; populates `RequestContext`; skipped for `@Public()` and `@TenantNotRequired()`.
4. `PermissionsGuard` — checks `@RequirePermissions('patients.write')` against the context. **A tenant-scoped route without `@RequirePermissions` is denied at runtime and fails the route-registry test** (deny by default).
5. **Resource-level checks** in services, through small policy functions per domain (e.g., `EncounterPolicy.canAmend(ctx, encounter)`), not ad-hoc `if`s in controllers.

Cross-tenant access to a record returns **404 Not Found**, not 403, so record existence is not leaked. (As built in Phase 2 the 404 is not yet logged as a security event; only `TenantGuard` membership denials are logged, with ids only.)

---

## 6. Database Architecture and Schema Standards

### 6.1 Naming and types

| Rule | Standard |
|---|---|
| Tables | `snake_case`, **plural** (`patients`, `tenant_memberships`) via Prisma `@@map`. |
| Columns | `snake_case` via `@map`; Prisma fields are `camelCase`, models `PascalCase` singular. |
| Primary keys | `id UUID`, UUIDv7 generated by Prisma (`@default(uuid(7)) @db.Uuid`) — time-ordered, index-friendly, non-guessable enough to not reveal counts. |
| Foreign keys | `<entity>_id`, always with a real FK constraint and an index. |
| Timestamps | `created_at`, `updated_at` as `timestamptz` on every table (`@default(now()) @updatedAt`, so raw inserts also get a value); all stored in UTC. Exception: `audit_logs` has `occurred_at` and no `updated_at` (append-only). |
| Calendar dates | `date` type (e.g., `birth_date`) — never a timestamp. |
| Money | `numeric(12,2)` + `currency` (`PHP` default). Never floating point. |
| Enums | PostgreSQL enums via Prisma for stable sets (statuses); lookup tables for tenant-configurable sets. |
| Booleans | `is_` / `has_` prefix. |
| Emails | Stored normalized (lowercase, trimmed) with a unique index. |
| Phone numbers | Stored normalized E.164 (`+63…`). |
| Optimistic locking | `version INT` on concurrently edited records (appointments, encounters, invoices). |
| Audit columns | `created_by_membership_id` / `updated_by_membership_id` on clinical and financial records. |
| Prisma schema files | Multi-file schema in `prisma/schema/`: `base.prisma` (generator + datasource), `identity.prisma` (`User`, `Permission`), `tenancy.prisma` (`Tenant`, `Branch`, `TenantMembership`, `Role`, `RolePermission`, `MembershipRole`) and `audit.prisma` (`AuditLog`) exist; one file per later domain (`patients.prisma`…). The datasource URL is not in the schema: Prisma 7 reads it from `prisma.config.ts` (CLI) and the driver adapter (runtime). The generated client is `src/generated/prisma` (gitignored; `npm run db:generate`). |

### 6.2 Foundational entities (outline only — finalized in child plans)

| Table | Scope | Purpose / key constraints |
|---|---|---|
| `users` | Global | **Phase 2:** `email` (required, unique, normalized), `full_name`, `status` (`pending` \| `active` \| `deactivated`), `platform_role` (`none` \| `platform_admin`). **Phase 3 added:** `password_hash` (globally omitted from Prisma results), `email_verified_at`, `password_changed_at`, `failed_login_count`, `locked_until`. |
| `sessions` | Global (Phase 3) | One row per refresh-token family: `active_tenant_id`, `principal_type`, user agent, IP, `last_used_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at`, `revoked_reason`. |
| `refresh_tokens` | Global (Phase 3) | SHA-256 hash of each issued refresh token, `rotated_at`; a rotated token presented again is reuse. |
| `user_tokens` | Global (Phase 3) | Hashed single-use tokens, `type` (`password_reset`, `account_setup`; `email_verification` is added when something produces it), `expires_at`, `used_at`. |
| `tenants` | Global (the root) | `name`, `slug` (the only unique column; two clinics may share a name), `status` (`active` \| `suspended` \| `deactivated`), `timezone` (default `Asia/Manila`), `contact_email?`, `contact_phone?`. |
| `branches` | Tenant | `UNIQUE(tenant_id, name)`, `address_line?`, `city?`, `province?`, `timezone?` override, `is_active`. |
| `tenant_memberships` | Tenant | `UNIQUE(tenant_id, user_id)`, status, job title, joined/removed dates. |
| `invitations` | Tenant (Phase 3) | Email, one role, hashed token, expiry, accepted/revoked timestamps; composite FKs to role and inviter membership; a partial unique index allows one open invitation per email per tenant. |
| `permissions` | Global | `key` unique, description. Seeded from code. |
| `roles` | Tenant | `UNIQUE(tenant_id, key)`, `is_system`. |
| `role_permissions` | Tenant | PK `(role_id, permission_id)` plus a non-PK `id` with `UNIQUE(tenant_id, id)` so the tenant-owned rule has no exceptions. |
| `membership_roles` | Tenant | PK `(membership_id, role_id)` plus the same non-PK `id`. |
| `audit_logs` | Tenant-attributed (`tenant_id` nullable for platform events; not in the tenant-owned registry) | Append-only (§8 item 13): `action`, `entity_type`, `entity_id?`, `changed_fields text[]` (names only), `actor_user_id?`, `actor_membership_id?`, `request_id?`, `ip?`, `occurred_at`. |

### 6.3 Future clinic entities — rationalized

| Proposed | Decision |
|---|---|
| Patients | `patients` — tenant-owned **records**, not login accounts. The same person at two clinics is two separate patient records (no cross-tenant patient identity — a privacy decision). A **patient portal is planned**: portal access is modelled by a tenant-owned `patient_portal_links` table (`tenant_id`, `patient_id`, `user_id`, `relationship` such as self/guardian, `status`; `UNIQUE(tenant_id, patient_id, user_id)`; composite FK to `patients`), not a single `patients.user_id` column, so one user can manage several patient records (e.g. a parent) and the link can be claimed, revoked and audited. Patients are **not** tenant members: they get no `tenant_memberships` row and no staff roles (see §3.3 principal types). |
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

- Every tenant-owned table declares `@@unique([tenantId, id])` (enforced by `test/architecture/tenant-registry.spec.ts`, which parses `prisma/schema/*.prisma` because Prisma 7's generated client exposes no `dmmf`).
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

- `prisma migrate dev` locally (`npm run db:migrate:dev -- --name <name>`); `prisma migrate deploy` in CI and the release pipeline (`npm run db:migrate:deploy`, or `docker compose run --rm migrate` locally); migrations committed and reviewed. The first migration, `20261118000000_tenancy_foundation`, arrived with Phase 2.
- Raw SQL in migrations for what Prisma cannot model (exclusion constraints, `pg_trgm`, check constraints, future RLS policies).
- **Role separation is already in place.** Migrations run as `doctayo_owner` (`DATABASE_MIGRATION_URL`, read by `prisma.config.ts`, CI and test setup, never by the app); the API runs as `doctayo_app` (`DATABASE_URL`: DML only, no DDL, not superuser, `NOBYPASSRLS`). Default privileges give the runtime role access to tables the owner creates later, so migrations need no per-table grants. Roles and grants come from `scripts/db/bootstrap.sql` (idempotent; run once by an admin, automatically by the Compose `postgres` container on first start of an empty volume).
- Migrations are never run automatically when the API starts.
- Seeds: there is no seed step. Permission rows are inserted by the migration that introduces a key (checked against the code catalog by a test); role templates live in code and are applied during tenant onboarding. Dev-only demo data, if ever needed, goes in a separate script that refuses to run in production.

---

## 7. REST API Conventions

### 7.1 General

- Base path: `/api/v1` (Nest global prefix `api` + URI versioning, default version `1`; **implemented**). Breaking changes → `/api/v2` for affected resources only. Health endpoints are version-neutral: `/api/health`, `/api/health/ready`.
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

The error envelope is **implemented**. Error `code`s are a documented, append-only catalog (`docs/error-codes.md`, source `src/common/errors/error-codes.ts`, kept in sync by a unit test). Codes named elsewhere in this plan (`INVALID_CREDENTIALS`, `VERSION_CONFLICT`…) are added to the catalog by the phase that produces them. Phase 2 added `TENANT_NOT_SELECTED`, `TENANT_SUSPENDED`, `TENANT_DEACTIVATED` and `TENANT_ACCESS_DENIED` and activated `UNAUTHENTICATED` and `FORBIDDEN`; `CONFLICT`, `METHOD_NOT_ALLOWED` and `RATE_LIMITED` are cataloged (see `docs/error-codes.md` for which is produced where). The frontend maps codes to friendly, large-print messages; the backend's `message` is a plain-language fallback. Stack traces, SQL, and Prisma error text are never returned.

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
# Auth (public unless noted) — implemented, Phase 3 (docs/authentication.md)
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh                     (refresh cookie + Origin)
POST   /api/v1/auth/logout                      (auth + Origin)
POST   /api/v1/auth/logout-all                  (auth + Origin)
POST   /api/v1/auth/switch-tenant               (auth, no tenant required)
POST   /api/v1/auth/password/forgot
POST   /api/v1/auth/password/reset
POST   /api/v1/auth/account/setup               (onboarded owners, token in body)
POST   /api/v1/auth/email/verify                (planned, Phase 4; plans/02 D6)

# Current user (auth, no tenant required) — implemented, Phase 3 (except PATCH)
GET    /api/v1/me
PATCH  /api/v1/me                               (planned, Phase 4)
POST   /api/v1/me/password
GET    /api/v1/me/memberships
GET    /api/v1/me/sessions
DELETE /api/v1/me/sessions/:sessionId

# Tenant (active tenant)
GET    /api/v1/tenant                            (implemented, Phase 2)
PATCH  /api/v1/tenant                            (implemented)
GET    /api/v1/branches                          (implemented, Phase 2)
POST   /api/v1/branches                          (implemented)
GET    /api/v1/branches/:branchId                (implemented)
PATCH  /api/v1/branches/:branchId                (implemented; no DELETE, deactivate with isActive)

# Members, invitations, roles
GET    /api/v1/members                          (planned, Phase 4)
PATCH  /api/v1/members/:membershipId            (planned, Phase 4; status, roles)
POST   /api/v1/invitations                      (implemented, Phase 3; members.invite)
POST   /api/v1/invitations/:invitationId/resend (implemented, Phase 3; members.invite)
POST   /api/v1/invitations/accept               (implemented, Phase 3; public, token in body)
GET    /api/v1/roles                            (planned, Phase 4)
GET    /api/v1/permissions                      (planned, Phase 4)

# Clinic operations (planned, Phases 5–6)
GET    /api/v1/patients?q=…
POST   /api/v1/patients
GET    /api/v1/patients/:patientId
GET    /api/v1/patients/:patientId/encounters
POST   /api/v1/appointments
POST   /api/v1/appointments/:appointmentId/cancel
POST   /api/v1/encounters/:encounterId/finalize
POST   /api/v1/encounters/:encounterId/prescriptions

# Platform administration (planned, Phase 4)
POST   /api/v1/admin/tenants
PATCH  /api/v1/admin/tenants/:tenantId/status
PATCH  /api/v1/admin/users/:userId/status
```

### 7.8 Swagger

- Swagger UI is served at `/api/docs` (JSON at `/api/docs-json`) when `SWAGGER_ENABLED` is true. Every controller has `@ApiTags`; every DTO property documented (`@ApiProperty`) with examples; error responses documented using the shared error schema.
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

> **Already enforced by the Phase 1 foundation:** items 7 (global validation, 1 MB body limit), 10 (CORS exact-origin allow-list, no wildcard, required in production), 11 (validated env, `.env` gitignored, no secrets in images), 12 (no bodies/queries/auth headers in logs; Observe redaction; static error messages), 16 (global exception filter, catalog text only), 17 (Helmet, `trust proxy` setting, no `X-Powered-By`), 18 (lockfile, CI audit), plus least-privilege DB role verification at startup (§6.6). Phase 2 added: item 5 (three-layer tenant isolation, cross-tenant requests answer 404; the security-event log for cross-tenant attempts covers membership denials only so far), item 6 (deny-by-default `PermissionsGuard`), item 8 (Prisma only; raw SQL limited to one reviewed tagged `$queryRaw` in `membership-resolver.ts`), and item 13 in part (append-only `audit_logs` with the `REVOKE`, written in the same transaction; auth events and medical-record reads are not audited yet). Items 1–4, 9, 14–15 arrive with the phases that need them.

> Data-privacy notes reference the Philippine Data Privacy Act of 2012 (RA 10173) and its IRR as design inputs. **This is not legal advice**; requirements must be confirmed with a qualified privacy/legal professional and the clinic's Data Protection Officer.

1. **Password security** — Argon2id (OWASP baseline, e.g., m=19 MiB, t=2, p=1, tuned on target hardware); min length 10, max 128; check against a common-password list; no composition rules that hurt usability; rehash on login when parameters change.
2. **JWT security** — short TTL, secret ≥ 256 bits from env, explicit algorithm allow-list, validate `exp`/`iat`; no sensitive data in claims.
3. **Refresh token rotation** — opaque, hashed at rest, rotated on every use, family revocation on reuse.
4. **Token revocation** — session-backed; logout, password change/reset, account deactivation, and membership removal take effect on the next request.
5. **Tenant isolation** — §3 three-layer model; cross-tenant access returns 404 and is logged as a security event.
6. **Authorization checks** — deny-by-default permissions guard; resource-level policies in services.
7. **Input validation** — global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`, `transform`); max lengths on all strings; request body size limit; UUID param validation.
8. **SQL injection prevention** — Prisma parameterized queries only; `$queryRawUnsafe` forbidden (lint rule); tagged `$queryRaw` with reviewed parameters only.
9. **Rate limiting & brute force** — global throttling; stricter limits on `login`, `refresh`, `password/forgot`, `invitations/accept`; per-account progressive delay/temporary lock after repeated failures (with limits to avoid lockout-as-DoS); failures for existing accounts are audited. **As built (Phase 3):** 300/min per IP default; login 5 per 15 min per IP+email and 30 per 15 min per IP; refresh 30/min; recovery, account setup and invitation acceptance 5 per 15 min per IP; password change 5 per 15 min per user; lockout for 15 minutes after 10 consecutive failures. Failed logins for unknown emails are not audited (no user id; they only count toward the throttle).
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
18. **Dependency hygiene** — lockfile committed, `npm audit` in CI (informational for now; make blocking once the baseline is understood), no pre-release packages in production paths. Prisma is pinned exactly to `7.10.1` for this reason (ADR-0001).

---

## 9. NestJS Code Organization

### 9.1 Directory layout

Existing today (Phase 1) and planned (marked *later*):

```
src/
  main.ts                      # create app -> applyAppSetup -> init -> applyPostInit -> listen
  app.setup.ts                 # ALL global concerns (prefix, versioning, pipes, filter, helmet, CORS, Swagger); shared with e2e tests
  app.module.ts                # Config, Observe, Prisma, Health, Tenancy, Audit, Tenants, Branches
  config/                      # env validation (class-validator) + typed namespaces; the only place that reads process.env
  common/
    errors/                    # error code catalog, DomainError, exception -> API error mapping, validation mapping
    filters/                   # AllExceptionsFilter
    http/                      # request id + access log middleware
    dto/                       # ApiResponse / PaginatedResponse envelopes, pagination query DTO
    decorators/                # @Public, @TenantNotRequired, @RequirePermissions; later: @PlatformAdmin, @CurrentContext
    guards/                    # AuthGuard, PermissionsGuard; later: PlatformAdminGuard
    auth/                      # Authenticator seam (AUTHENTICATOR token, Principal); the production binding lives in modules/auth
    validation/                # IANA timezone validator, trim transform
    utils/                     # later
  observability/               # Observe wiring and redaction settings
  prisma/                      # PrismaService (pg adapter, least-privilege check), TenantPrismaService + tenant-owned-models registry, PrismaModule (global)
  generated/prisma/            # generated client (gitignored)
  context/                     # RequestContext (AsyncLocalStorage) + its middleware (mounted by TenancyModule)
  modules/
    health/                    # liveness + readiness (exists)
    audit/                     # AuditService (same-transaction, append-only audit_logs)
    auth/                      # login, access tokens, sessions, refresh rotation, password flows, account setup, invitation acceptance, throttle config (JwtAuthenticator)
    users/                     # /me, /me/memberships, /me/sessions, POST /me/password; later: global profile, platform account admin
    tenants/                   # TenantOnboardingService, TenantLifecycleService, tenant profile endpoints
    tenancy/                   # TenantGuard, MembershipResolver, TenancyModule (context middleware + global guards)
    branches/                  # branch endpoints (tenant client only)
    members/                   # invitations (create, resend; tenant client only); later: member administration
    mail/                      # transactional-outbox email: MailQueue, mail classes, outbox handler, transport selection
    maintenance/               # nightly cleanup job (@nestjs/schedule)
    access-control/            # catalog.ts (permissions + role templates); later: roles, policies
    patients/ practitioners/ appointments/ clinical/ services-catalog/ billing/ notifications/ reports/ admin/   # later
prisma/
  schema/                      # multi-file schema: base, identity, tenancy, audit; one file per later domain
  migrations/                  # 20261118000000_tenancy_foundation (Phase 2), 20261119000000_authentication (Phase 3) and later
  seed/                        # later
scripts/
  db/                          # bootstrap.sql (roles, databases, grants), bootstrap.mjs, grants.sql, reset-test-db.mjs
  docker/                      # postgres-init.sh (runs bootstrap.sql on the first start of the Compose database)
test/
  setup/                       # global setup (migrates the *_test DB), env loading, app factory, log capture
  architecture/                # forbidden-patterns, prisma-access (who may inject PrismaService; no test code in src), tenant-registry (composite-FK convention)
  *.e2e-spec.ts                # health, errors, security, conventions, database, swagger, request id/logging; tenancy-schema, tenancy-guards, tenant-prisma, audit, tenant-onboarding, tenant-isolation; Phase 3: auth-schema, auth-sessions, auth-login, auth-endpoints, auth-me, auth-password, auth-security, invitations, cleanup, route-registry, route-registry
  support/                     # test-only controllers, TestAuthenticator, tenancy fixtures (Clinic A, Clinic B, user M), db helpers, auth/mail helpers, TestClock, resettable throttler storage
docs/                          # architecture, api-conventions, authorization, database, docker, environment, error-codes, multitenancy, security-privacy, adr/
plans/                         # child plans (00, 01 and 02 implemented; 03-05 not yet written)
Dockerfile  docker-compose.yml  .dockerignore  .github/workflows/ci.yml
```

### 9.2 Conventions

| Element | Convention |
|---|---|
| Modules | One per bounded domain; export only services other modules legitimately need. No circular imports; shared needs go to `common/` or an explicit service. |
| Controllers | Thin: routing, DTO binding, decorators, response mapping. No Prisma, no business rules. |
| Services | Business logic, transactions, policies, audit calls. Use the tenant-scoped client in domain modules. |
| Repositories | Only where queries become complex or raw SQL is needed; otherwise services use Prisma directly (boring > clever). |
| DTOs | `CreateXDto`, `UpdateXDto`, `XQueryDto`, `XResponseDto`; `class-validator` + `@ApiProperty`; response DTOs built by explicit mapper functions. |
| Guards | Global `APP_GUARD`s registered by `TenancyModule`, in the order in §5.2. |
| Decorators | Metadata only; no logic. |
| Interceptors | Kept minimal; no global response wrapping (ADR-0005): controllers return `{ data }` / `{ data, meta }` explicitly. |
| Middleware | Request id, access log, security headers, and the `RequestContext` AsyncLocalStorage store (mounted by `TenancyModule` after the body parsers). Not used for authentication or tenant decisions; guards do that. |
| Exception filters | One global filter producing the standard error shape. Domain code throws `DomainError(code, status)`. |
| Prisma integration | Single `PrismaService` (lifecycle hooks, `@prisma/adapter-pg`, query logging off; **exists**); tenant-scoped extension exposed as `TenantPrismaService` (**exists**; wraps the extended client, delegates and `$transaction` only). Prisma errors never escape to the client unmapped. |
| Configuration | `@nestjs/config`, namespaced, validated at boot; no `process` access outside `src/config` and tests (oxlint rule). Existing namespaces: `app`, `database`, `cors`, `logging`, `swagger`, `observe`; later phases add `auth`, `mail`, … Adding a variable means: declare and validate it in `env.validation.ts`, document it in `docs/environment.md` and `.env.example`, and pass it to the container through Compose/host environment. |
| Logging | Nest `ConsoleLogger` configured in `app.setup.ts` (`LOG_FORMAT` pretty/json, `LOG_LEVEL`), correlated by Observe; request id on every access-log line; PHI-free (path without query string). |
| ESM | `.js` suffix on relative imports; `import.meta.dirname`; Vitest `vi.fn()`. |
| Tests | `*.spec.ts` next to the code (plus `test/architecture/**`); `*.e2e-spec.ts` under `test/`, run against a real PostgreSQL database whose name must end in `_test`. |

---

## 10. Development Phases and Milestones

Order adjustments vs. the requested outline (with reasons):
- **Audit log foundation moves to Phase 2.** Auth, membership, and role events must be audited from the first day they exist; retrofitting is error-prone. Phase 6 keeps audit *query/reporting* APIs.
- **Phase 2 includes a minimal `users` table** because memberships reference users; full auth flows remain in Phase 3. Phase 2 tests use a test-only token helper.
- **Services catalog moves to Phase 5** because appointments and encounters reference services.

### Phase 1 — Project Foundation — **COMPLETE** (`plans/00-project-foundation.md`)
- **Objectives:** A runnable, configured, conventional skeleton connected to PostgreSQL.
- **Delivered:** Prisma pinned to 7.10.1 with `prisma.config.ts`, multi-file schema folder and generated client (Q1 resolved, ADR-0001); `PrismaService` with fail-fast connect and least-privilege role check; validated `@nestjs/config`; global prefix `/api` + URI versioning; global `ValidationPipe`; single exception filter + error code catalog; sanitized request ids + access log; Helmet + CORS from config; Swagger at `/api/docs`; liveness/readiness health endpoints; Observe PHI redaction; owner vs runtime DB roles and idempotent bootstrap; oxlint rules and architecture tests; separate `*_test` database for e2e; GitHub Actions CI (lint, format, typecheck, unit, migrate, e2e, build, audit, Docker build); default Hello World controller removed; project docs and ADRs 0001–0007.
- **Pulled forward from Phase 7:** the multi-stage Dockerfile (`runtime`, `migrate`) and the local Docker Compose stack (§2.1), because the local database runs in Docker.
- **Not delivered / still open:** hosting and region (Q4). (Rate limiting and authentication arrived in Phase 3; the first Prisma migration arrived with Phase 2.)
- **Key decisions:** Prisma 7.10.1 pinned; Express kept; error envelope and explicit success envelopes; multi-file Prisma schema; oxlint kept (no ESLint); one image configured by environment variables.
- **Done when (met):** `npm run start:dev` or `docker compose up --build -d` boots against Postgres; invalid env fails fast; `/api/health/ready` checks the DB; Swagger renders; CI defines the full pipeline; a deliberate error returns the standard shape without internals.

### Phase 2 — Multi-Tenancy Foundation — **COMPLETE** (`plans/01-multitenancy.md`)
- **Objectives:** Tenancy data model and automatic, enforced tenant isolation.
- **Delivered:** `users` (minimal), `tenants`, `branches`, `tenant_memberships`, `permissions`, `roles`, `role_permissions`, `membership_roles`, `audit_logs` (first migration, with the append-only `REVOKE`); composite-FK convention enforced by a registry test; `RequestContext` (AsyncLocalStorage); pluggable authenticator seam with a fail-closed `DenyAllAuthenticator`; global `AuthGuard` -> `TenantGuard` -> `PermissionsGuard` (deny by default); `@Public()`, `@TenantNotRequired()`, `@RequirePermissions()`; `TenantPrismaService` (Prisma client extension) + tenant-owned model registry; `AuditService` (same transaction); tenant onboarding transaction and tenant status lifecycle (services); `GET/PATCH /api/v1/tenant` and branch endpoints (no delete); isolation test harness (Clinic A, Clinic B, user M); route-registry and Prisma-access architecture tests; docs and ADRs 0008-0010.
- **Moved into Phase 2 from Phase 4 (approved, plans/01 D1):** the RBAC data model, permission catalog, role templates and `PermissionsGuard`. **Deferred to Phase 3 (D2):** the `invitations` table.
- **As-built deviations:** recorded in `plans/01-multitenancy.md` §17 (context middleware mounted by `TenancyModule`; membership lookup is one raw SQL statement; lifecycle methods take no `reason`; `AuditLog` exposed append-only on the tenant client; join tables carry a non-PK `id`; only `slug` is unique on tenants; `pending` users are denied by `TenantGuard`; cross-tenant 404s are not logged as security events yet).
- **Dependencies:** Phase 1.
- **Key decisions:** tenant-in-session model; global identity with tenant-scoped authorization (one account per human, roles on the membership); RLS deferred with role separation in place; composite FKs mandatory; `users.email` required (patient-portal access will need an email); the patient portal is modelled as `patient_portal_links` plus a separate principal type, not as memberships.
- **Done when (met):** A query on a tenant-owned model without context throws; cross-tenant reads/writes on branches return 404 in tests; composite FKs reject cross-tenant references at the DB level (tested with raw inserts); onboarding creates tenant + branch + roles + owner atomically and is audited.
- **Resolved in Phase 3:** the JWT authenticator replaced `DenyAllAuthenticator`, and onboarded owners get credentials through the emailed account-setup link. **Verification gaps recorded at the end of Phase 2:** `docker compose run --rm migrate`, the GitHub Actions run and `npm run db:test:reset` were not executed when Phase 2 was completed.

### Phase 3 — Authentication — **COMPLETE** (`plans/02-authentication.md`)
- **Objectives:** Secure global identity and sessions.
- **Delivered:** Argon2id hashing with a password policy (10-128 characters, bundled common-password list, not containing the email); access JWT (HS256, 15 min, no tenant/role/permission claims); server-side sessions (14-day idle, 30-day absolute) re-verified on every request by `JwtAuthenticator`; opaque refresh tokens in an httpOnly cookie, rotated on every use with reuse detection (no grace window); `POST /auth/login`, `refresh`, `logout`, `logout-all`, `switch-tenant`; `GET /me`, `/me/memberships`, `/me/sessions`, `DELETE /me/sessions/:id`, `POST /me/password`; forgot/reset password; account setup for onboarded owners; invitations (create, resend, accept for new, pending and existing users; permission `members.invite`); `ThrottlerGuard` as the first global guard (login, refresh, recovery, accept; per-user limit on password change) and account lockout; email through `@nestjs/mail` + `@nestjs/outbox` (queued in the same transaction, delivered after commit with retries); nightly cleanup job; audited auth events; log-hygiene and public-route allow-list tests.
- **Deferred (decided in the plan):** `POST /auth/email/verify` (D6), `PATCH /me`, invitation listing/revocation and member administration (Phase 4), patient-portal principals, MFA/SSO, a shared throttle store.
- **As-built deviations:** recorded in `plans/02-authentication.md` §19 (the active tenant lives on the session and the token has no `tid`; refresh-token cookie only; mail templates are inline TypeScript; a larger common-password source than planned; emailed tokens are held in the outbox until delivered; `Cache-Control: no-store` on auth responses; an ownership-notice email for existing owners).
- **Dependencies:** Phase 2; Q3, Q5 (answered), Q6 (still open for production).
- **Key decisions:** ADR-0011 (own authentication on `@nestjs/jwt` + `argon2`), ADR-0012 (refresh-token cookie), ADR-0013 (mail and outbox).
- **Done when (met):** every flow is covered by e2e tests, including token reuse, expired and revoked sessions, enumeration-safe responses and lockout; password change/reset revoke sessions; switch-tenant refuses non-members; the Phase 2 tenant routes work end to end with real tokens; no password, token or cookie value appears in verbose logs; no email is sent for a rolled-back transaction.
- **Not yet verified:** going live needs a production email provider (Q6). The GitHub Actions run with the new variables, the production-build start with `NODE_ENV=production` against a TLS database, and the Docker run of the full sign-in flow with real data were not executed (the Docker images build, migrate and boot, and `argon2` loads in the runtime image).

### Phase 4 — User Management & Authorization (`plans/03-user-management-and-authorization.md`)
- **Objectives:** RBAC and member administration within tenants.
- **Deliverables:** Permission catalog growth (the catalog, role templates, `role_permissions`, `membership_roles`, `PermissionsGuard` and the route-registry test already exist from Phase 2); resource-policy pattern; member listing, role assignment, suspension/removal with last-owner invariant; invitations management; global profile management; platform admin endpoints (tenants, user status; `POST /admin/tenants` calls the Phase 2 onboarding service) and `@PlatformAdmin()`; the full role x endpoint matrix.
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
- **Deliverables:** Coverage gaps closed; full tenant-isolation and authorization matrices; security tests (§11.7); RLS spike on clinical tables with measured overhead and a go/no-go recommendation; load tests on hot endpoints (login, patient search, appointment listing); production deployment review of the existing Docker image and configuration (image size and base-image patching, TLS to the managed database including the provider CA bundle, secret injection, `TRUST_PROXY`, `CORS_ALLOWED_ORIGINS`, Observe keys) — the Dockerfile and `migrate` target already exist; production migration pipeline (`migrate deploy` via the `migrate` image); backups + point-in-time recovery verified by a restore drill; Observe alerts (error rate, latency, security events); runbooks; privacy documentation support (data inventory, retention schedule).
- **Dependencies:** Phases 1–6; Q4.
- **Done when:** All suites green in CI; restore drill succeeds; no critical/high vulnerabilities open; p95 latency targets met (to be set in the child plan); security checklist signed off.

> Testing is **continuous**, not deferred to Phase 7: every phase ships unit, integration, and isolation tests for what it adds.

---

## 11. Testing Strategy

### 11.1 Layers

| Layer | Tooling | What |
|---|---|---|
| Unit | Vitest, `vi.fn()` | Pure logic: policies, token utilities, mappers, validators, state machines. No DB. |
| Integration | Vitest + real PostgreSQL test DB (`vitest.config.e2e.ts`) | Services + Prisma against a migrated schema: constraints, composite FKs, exclusion constraints, transactions, the tenant extension. **No mocking of Prisma for data-access behavior.** |
| E2E API | Vitest + supertest + `Test.createTestingModule` | Full HTTP stack: guards, validation, error shapes, status codes. |

### 11.2 Database testing
- Dedicated test database `doc_tayo_test` (created by `scripts/db/bootstrap.sql`); the e2e global setup refuses any database whose name does not end in `_test`, then applies migrations once per run as the owner role (`npm run db:test:reset` resets it; re-run the bootstrap script afterwards). E2E files run one at a time (`fileParallelism: false`) because they share the database. `.env.test` (gitignored; template `.env.test.example`) holds its URLs; CI supplies real environment variables. The e2e suites cover health, error shape, security headers/CORS, API conventions, request id and log hygiene, database connectivity and Swagger (Phase 1), and tenancy schema constraints, guards, the tenant Prisma client, audit, onboarding, isolation and the route registry (Phase 2). Each tenancy file builds its own Clinic A/B fixtures (`test/support/tenancy-fixtures.ts`) and empties the tenancy tables with `resetTenancyData` (`test/support/db.ts`, `TRUNCATE`, leaving the migration-managed `permissions` rows).
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
- **Exists (Phase 1):** `test/architecture/forbidden-patterns.spec.ts` (no `$queryRawUnsafe`/`$executeRawUnsafe`, no `process` outside config/tests, no `console`).
- **Exists (Phase 2):** `test/architecture/prisma-access.spec.ts` (modules outside the allow-list do not use the raw `PrismaService`; nothing under `src/` imports test code or `TestAuthenticator`), `test/architecture/tenant-registry.spec.ts` (every `tenantId` model is registered, has `@@unique([tenantId, id])` and composite FKs), `test/route-registry.e2e-spec.ts` (every route is public, tenant-not-required, or tenant-scoped with permissions). `prisma-access.spec.ts` and the route-registry test carry self-tests proving their checks can fail.
- **Later:** platform-admin routes join the route-registry categories in Phase 4.

### 11.7 Security testing
Injection payloads in search/filter params, oversized payloads, mass-assignment attempts (extra fields like `role`, `tenantId`, `status`), CORS behavior, rate-limit behavior, error responses free of stack traces/SQL, logs free of PHI (assert on captured logs for clinical routes), dependency audit.

### 11.8 Performance testing
Seeded realistic volumes (multiple tenants, tens of thousands of patients/appointments) to validate indexes (`EXPLAIN` on hot queries) and p95 latency targets.

---

## 12. Documentation Standards

Kept in `docs/`, short and maintained alongside code (a PR changing behavior updates the doc):

| Document | Contents |
|---|---|
| `docs/architecture.md` | Module map, request lifecycle (guards order), key decisions. **Exists** (Phase 1 content). |
| `docs/adr/NNNN-*.md` | Architecture Decision Records (one page each). **Exist:** 0001 Prisma version, 0002 TypeScript strictness (amended in Phase 2), 0003 database roles, 0004 request ids and Observe, 0005 error envelope, 0006 lint and guards, 0007 Docker, 0008 tenant context, 0009 composite foreign keys, 0010 RLS deferred. **Later:** token strategy, etc. |
| `docs/multitenancy.md` | Tenant model, context propagation, isolation layers, how to add a tenant-owned model safely (checklist). **Exists** (Phase 2). |
| `docs/authentication.md` | Token/session lifecycle with sequence diagrams (Mermaid): login, refresh rotation, reuse detection, switch tenant, password reset. |
| `docs/authorization.md` | Permission catalog, default role matrix, policy pattern. **Exists** (Phase 2 catalog; policy pattern arrives with Phase 4/5). |
| `docs/database.md` | Roles, Prisma layout, migrations and test database (**exists**); later also conventions (§6), ERD (Mermaid, generated from Prisma schema), global vs tenant-owned tables, retention per table. |
| `docs/api-conventions.md` | §7 in reference form. **Exists** (Phase 1 content). |
| `docs/error-codes.md` | Stable error code catalog. **Exists.** |
| OpenAPI | Generated by `@nestjs/swagger`; exported `openapi.json` committed by CI. The API contract for the frontend. |
| `docs/environment.md` | Required env vars, local setup, seeding, running tests. **Exists.** |
| `docs/docker.md` | Docker and Compose guide: local architecture, networking, volumes, health checks, migrations, reset, production use of the same image. **Exists.** |
| `docs/deployment.md` | Build, migrate, release, rollback, backups/restore, secrets, monitoring/alerts. |
| `docs/security-privacy.md` | Data classification, logging rules, audit coverage, retention, incident response (not legal advice). **Exists** (logging/redaction rules only so far). |
| `README.md` | Project-specific quick start and links. **Replaced** in Phase 1. |

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
| In-process jobs with outbox | Redis (shared rate-limit store, caching) and BullMQ queues, only when volume requires; the Docker/config structure already allows adding them without redesign (§2.1) |
| Basic reports | Analytics, PhilHealth claims integration, lab/HL7/FHIR integrations |

---

## 14. Risks and Trade-offs

| Risk | Impact | Mitigation |
|---|---|---|
| Accidental upgrade to the Prisma 8 RC (npm `latest` for the CLI) | Build/runtime breakage; unstable APIs under PHI workloads | **Mitigated:** exact pins at `7.10.1` (ADR-0001); never run `npm i prisma@latest`. |
| Local `docker compose down -v` or a changed DB password applied to an existing volume | Local data loss / confusing auth failures | Documented in `docs/docker.md`; the volume is local-only throwaway data. Production data is never in Compose. |
| Production TLS to a managed database with a private CA (for example RDS) fails under `verify-full` | API cannot connect | Supply the CA bundle via `NODE_EXTRA_CA_CERTS`; verify in the Phase 7 deployment review. |
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

1. ~~**Prisma version.**~~ **Resolved (Phase 1, ADR-0001):** Prisma 7.10.1 pinned for CLI, client and `@prisma/adapter-pg`; revisit Prisma 8 once it is GA with matching packages.
2. **RLS timing.** Recommended: defer to a Phase 7 spike (with DB role separation from Phase 1). Recorded as deferred in ADR-0010 and built that way in Phase 2; still needs explicit approval: approve, or require RLS on clinical tables from Phase 5?
3. ~~**Onboarding and registration.**~~ **Resolved (Phase 3, plans/02 D3):** platform-admin-provisioned tenants and invitation-only staff accounts; public self-registration is not implemented.
4. **Hosting and data location.** *Partly answered:* the working assumption is a container host such as AWS EC2 with a managed PostgreSQL such as AWS RDS, but nothing is provisioned or committed. Still needed before Phase 7: confirm provider, region, backups/PITR, secret management, and cross-border data transfer considerations. The image and configuration already work with any externally supplied `DATABASE_URL`.
5. ~~**Refresh token transport.**~~ **Resolved (Phase 3, ADR-0012):** the frontend and API share a site, so the refresh token is an httpOnly cookie. If that ever changes, the token would move to the request/response body (the rest of the design is unchanged).
6. **Email and SMS providers.** *Partly answered:* email goes through `@nestjs/mail` and the outbox; `MAIL_TRANSPORT=smtp` (SMTP via `SMTP_URL`) is the only production transport wired today (the package's HTTP provider transports are not wired). **Still needed before go-live:** which transactional email provider and sender domain. Is SMS required at launch (likely valuable for older patients' reminders)?
7. **Retention periods.** What retention periods apply to medical, financial, and audit records? (Needs clinic/legal input.)
8. **Domain rules.** Need clinician/clinic-owner input on prescription requirements, ICD-10 usage, Senior Citizen/PWD discount handling, PhilHealth needs, and appointment rules (walk-ins, slot lengths).
9. **Doctors without accounts.** Must the system record practitioners who never log in (e.g., visiting doctors)? Current design assumes every practitioner is a member user.
10. **MFA.** Should MFA for owners/administrators be in scope before go-live rather than a post-launch enhancement?
