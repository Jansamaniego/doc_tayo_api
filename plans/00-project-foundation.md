# Plan 00 — Project Foundation (Master Plan Phase 1)

> **Parent:** [`../plan.md`](../plan.md) (source of truth). This plan implements **Phase 1 — Project Foundation** only.
> **Status:** Draft for review. **No implementation starts until approved.**
> **Scope guard:** infrastructure and skeleton only. No tenant, auth, user, role, branch, or clinic code (see §14).

Items marked **`REQUIRES APPROVAL`** are not assumed approved. They are collected in §17.

---

## 1. Baseline: What Exists Today (verified)

| Area | Finding | Consequence |
|---|---|---|
| Runtime | Node `v24.22.2`; ESM (`"type": "module"`, `nodenext`); TS `6.0.3` strict | Keep. Prisma 7.10.1 supports Node `^20.19 \|\| ^22.12 \|\| >=24`. |
| NestJS | `@nestjs/common/core/platform-express/testing` `12.4.2`, CLI `12.0.12` | Keep Express. All planned Nest packages publish `^12` peer ranges (see §4). |
| Tests | Vitest `4.1.12`; `*.spec.ts` and `*.e2e-spec.ts`; supertest. **Baseline run: unit 1/1, e2e 1/1 pass**, `tsc --noEmit` clean, `oxlint` clean | Existing test setup works, including constructor DI under Vitest. Keep it. |
| Lint/format | **oxlint** `1.93` (type-aware, `typescript/no-floating-promises`) + Prettier (`singleQuote`, `trailingComma: all`) | **ESLint is not added.** oxlint is the established linter; replacing a working setup is out of scope. See §10 for what oxlint can and cannot enforce. |
| Prisma | `prisma@8.0.0-rc.33` (**release candidate**) + `@prisma/client@7.10.1`; `prisma.config.ts` uses Prisma 8 `definePrismaConfig` with only a `skills` section; `postinstall: prisma skills sync` | Mixed majors and an RC. **Replaced in M1** (§3). |
| Prisma 8 leftovers | Untracked `.agents/`, `.claude/`, `.cursor/`, `.devin/` skill folders (Prisma Composer / Platform, Prisma 8 only); `node_modules` contains `@prisma/composer*` | Describe an API we will not use; misleading to agents. **`REQUIRES APPROVAL`** to delete (§17-A3). |
| Prisma schema / migrations | None. No `prisma/` directory | Greenfield. |
| Config | None. `app.module.ts` reads `process.env.OBSERVE_*` directly | Violates the future "no `process.env` outside config" rule → refactored in M3. |
| `main.ts` | `NestFactory.create` + `instrument: ObserveInstrument`; no prefix, versioning, pipes, helmet, CORS, shutdown hooks | All added in M4–M6. |
| Observe | `ObserveModule.forRoot({ appKey, appSecret, serviceId })` with defaults | Defaults need hardening (§8). |
| Docker / CI | No `docker-compose`, Dockerfile, `.github/`, `plans/`, `docs/` | All created. |
| `.gitignore` | Ignores `.env`, `.env.*.local`, `*.tsbuildinfo`, `/dist`; **not** `.env.test`, not Prisma generated output | Extended in M1/M2. |
| Git | `master` branch, no commits; everything untracked | Branching/commit strategy is the user's call. Milestones are written to be one commit each. |
| `.env` | Contains Observe keys (secret — never print or commit). The user supplied a `DATABASE_URL` as the `postgres` superuser | Superuser must not be the runtime identity. See §3.5, §17-A2. |

---

## 2. Resolved Master-Plan Questions

### Q1 — Prisma version  (master plan §15-1)

**Decision: Prisma ORM `7.10.1` for all packages, pinned exactly (no `^`).**

Evidence gathered (npm registry, today):

| Package | `latest` | other tags |
|---|---|---|
| `prisma` (CLI) | **`8.0.0-rc.33`** (a release candidate sits on `latest`) | `prev` = `7.10.1` |
| `@prisma/client` | `7.10.1` | no stable 8.x |
| `@prisma/adapter-pg` | `7.10.1` | no stable 8.x |

Reasoning:
- `npm install prisma` currently installs the **RC** — the cause of today's mismatch. Pinning is mandatory, not stylistic.
- Prisma 8 has no stable client or adapter. The task and master plan §8.18 forbid RCs in production paths for a system holding patient data.
- Prisma 7 is the current stable major with a matching CLI, client and `pg` adapter, all at `7.10.1`.

Trade-offs / consequences:
- `prisma.config.ts` moves from the Prisma 8 `definePrismaConfig`/`skills` shape to the Prisma 7 `defineConfig` shape (§3.1).
- The `postinstall: prisma skills sync` script is removed (Prisma 8-only command).
- Prisma 8 migration is deferred until it is GA with a matching client; an ADR records this (ADR-0001).

Remaining uncertainty (resolved by a spike in M2, before anything depends on it):
- Whether `prisma generate` / `migrate` succeed with a schema containing **no models**. Fallback: a documented migration-free state, or a single non-domain placeholder is **not** acceptable (no throwaway tables); instead defer the first `generate` check to Phase 2 and have M2 verify with `datasource` + `generator` only.
- The exact Prisma 7 behavior for loading `.env` (Prisma 7 no longer auto-loads it, to my knowledge). Plan assumes it does not and loads explicitly (§3.1). Verify against `prisma --help`/docs at install time.

Status: **Decided per the task's instruction ("choose a stable version"); `REQUIRES APPROVAL` only for the cleanup side-effects** (deleting Prisma 8 skill folders, §17-A3).

### Q4 — Hosting and data location  (master plan §15-4)

**Decision: Phase 1 is provider-neutral. No hosting choice is required to complete Phase 1.**

Phase 1 only depends on Q4 for (a) PostgreSQL version/feature floor, (b) TLS to the database, (c) how the two DB roles get created. Neutral assumptions:

| Concern | Phase 1 position |
|---|---|
| PostgreSQL | **Major 17** locally and in CI (a local `psql 17.6` client exists). Any managed offering at ≥ 15 that allows creating roles and `ALTER DEFAULT PRIVILEGES` is acceptable. |
| Packaging | The API is a stateless process configured only by environment variables. Docker image is a Phase 7 deliverable. |
| TLS to DB | `DATABASE_SSL` config switch (`disable` \| `require` \| `verify-full`); **must not be `disable` in production** (validated). |
| Role creation | `scripts/db/bootstrap.sql` (idempotent) creates roles and grants. On a managed provider it is run once by an admin; documented in `docs/database.md`. |
| Region / residency / backups / PITR | Not addressed in Phase 1; remain open for Phase 7. |

Status: **`REQUIRES APPROVAL`** — the user must still answer hosting provider and region before Phase 7 (deployment). It does **not** block Phase 1. Risk: a provider that forbids custom roles would force a redesign of the role split (§3.4); low probability on mainstream managed Postgres.

---

## 3. Prisma and Database Foundation

### 3.1 Prisma 7 configuration

Dependencies (exact):

| Package | Version | Kind | Why |
|---|---|---|---|
| `@prisma/client` | `7.10.1` | dep | Runtime client |
| `@prisma/adapter-pg` | `7.10.1` | dep | Prisma 7 requires a driver adapter; `pg` is its dependency |
| `prisma` | `7.10.1` | devDep | CLI (generate/migrate) |

(`pg`/`@types/pg` come transitively; do not add them separately unless the adapter's version range requires it.)

`prisma.config.ts` (Prisma 7 shape; verified from `@prisma/config@7.10.1` typings: `schema`, `migrations.path`, `migrations.seed`, `datasource.url`, `datasource.shadowDatabaseUrl`):
- `schema: 'prisma/schema'` (folder → multi-file schema, recursively collected).
- `migrations: { path: 'prisma/migrations' }`.
- `datasource.url` ← **`DATABASE_MIGRATION_URL`** (owner role). **The CLI never uses the runtime URL.**
- `datasource.shadowDatabaseUrl` left unset locally (owner role has `CREATEDB`, §3.4); production uses `migrate deploy` only, which needs no shadow DB.
- Loads `.env` explicitly via Node's built-in `process.loadEnvFile()` guarded by try/catch (no `dotenv` dependency). `prisma.config.ts` is a tooling file outside `src/`, so it is a documented exception to the `process.env` rule.

Schema files (`prisma/schema/`), one file per concern; Phase 1 creates only:

| File | Content |
|---|---|
| `base.prisma` | `generator client { provider = "prisma-client", output = "../../src/generated/prisma" }` and `datasource db { provider = "postgresql" }` (no `url` — in Prisma 7 the URL lives in `prisma.config.ts` and the adapter). |

Later phases add `identity.prisma`, `tenancy.prisma`, etc. No models in Phase 1.

Generated client: `src/generated/prisma/` — **gitignored**, generated by `prisma generate` (run in `postinstall`-free fashion: explicit `npm run db:generate`, plus a `prebuild`/`pretypecheck`/`pretest` chain; §10). `tsconfig.build.json` already includes `src`, so generated TS compiles with `nest build`. Imports from it use the `.js` suffix like all ESM code.

> Verify at M2: the `prisma-client` generator's exact ESM output/`importFileExtension` options for `nodenext`. This is the most likely place for a hiccup; M2 contains a build-and-boot check before any other code depends on it.

### 3.2 `PrismaService` (`src/prisma/`)

- Extends the generated `PrismaClient`, constructed with `new PrismaPg({ connectionString, max: pool.max, ssl }, { schema: 'public' })`. The adapter's `schema` option (verified in `@prisma/adapter-pg@7.10.1` typings) replaces the old `?schema=public` URL parameter, which is a Prisma-engine feature and not a `pg` one. **The user-supplied `?schema=public` is therefore dropped from the runtime URL**; the schema is set in code (config key `database.schema`, default `public`).
- Lifecycle: `OnModuleInit` → `$connect()` (fail fast: the app does not boot if the DB is unreachable); `OnModuleDestroy` → `$disconnect()`. `app.enableShutdownHooks()` in `main.ts`.
- Provided by a global-free `PrismaModule` exporting `PrismaService`. Phase 2 will add `TenantPrismaService` beside it; nothing in Phase 1 blocks the Prisma Client extension approach (an extended client is `$extends(...)` of this same base client).
- Logging: Prisma `log` events routed to Nest `Logger` at `warn`/`error` only; query logging never enabled by default (queries can carry PHI in params). Prisma error messages are logged server-side only after Observe redaction (§8).
- Raw SQL: tagged `$queryRaw` only; `$queryRawUnsafe`/`$executeRawUnsafe` forbidden (§10).

### 3.3 Docker Compose (local PostgreSQL)

`docker-compose.yml` (repo root):
- Service `postgres`, image `postgres:17` pinned to a minor tag (e.g. `17.x-alpine`; exact tag chosen at implementation after checking Docker Hub).
- Bound to `127.0.0.1:5432` only; named volume for data; healthcheck `pg_isready`.
- Bootstrap superuser (`POSTGRES_USER`/`POSTGRES_PASSWORD`) is used **only** by the container's init and by `scripts/db/bootstrap.sql`; it is not an application credential.
- `scripts/db/init/` mounted into `/docker-entrypoint-initdb.d/`, runs once on an empty volume: creates roles and both databases (`doc_tayo`, `doc_tayo_test`) and applies grants (§3.4).
- One container, two databases — no second server, consistent with "one PostgreSQL database" per environment; the test DB is a separate database so tests never touch dev data.

### 3.4 Database roles (owner vs runtime)

Created by `scripts/db/bootstrap.sql` (idempotent: `DO $$ … IF NOT EXISTS …`). Role names proposed: **`doctayo_owner`**, **`doctayo_app`** (`REQUIRES APPROVAL` on names only; low stakes).

| Role | Attributes | Used for |
|---|---|---|
| Bootstrap superuser (`postgres`) | superuser | Container init and running `bootstrap.sql` **only**. Never in `.env` used by the app, tests, or Prisma CLI. |
| `doctayo_owner` | `LOGIN`, `NOSUPERUSER`, `NOBYPASSRLS`, `CREATEDB` (local/CI only, for Prisma shadow DB), **owns** the databases and the `public` schema | `prisma migrate`, schema changes, test DB reset. Via `DATABASE_MIGRATION_URL`. |
| `doctayo_app` | `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOBYPASSRLS`; **no DDL** | The running API and e2e tests. Via `DATABASE_URL`. |

Grants (per database):
1. `REVOKE ALL ON DATABASE … FROM PUBLIC; GRANT CONNECT ON DATABASE … TO doctayo_app;`
2. `REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO doctayo_app;`
3. `ALTER DEFAULT PRIVILEGES FOR ROLE doctayo_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO doctayo_app;` and `… GRANT USAGE, SELECT ON SEQUENCES TO doctayo_app;`

Why default privileges: tables created later by migrations (as owner) become usable by the runtime role automatically, with no per-migration grant boilerplate. Later phases tighten specific tables (e.g., `audit_logs`: revoke `UPDATE, DELETE`, master plan §8.13) in their own migrations. `NOBYPASSRLS` on both roles and a non-owner runtime role keep the RLS option from master plan §3.6 open.

Enforcement that the app is not running as owner/superuser:
- Startup check in `PrismaService.onModuleInit` (cheap): `SELECT current_user, rolsuper, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`. If superuser or `bypassrls` → **refuse to start in `production`**, warn in `development`/`test`. Implemented with the tagged `$queryRaw`.
- Integration test (§12): connected role is `doctayo_app`, cannot `CREATE TABLE` in `public`.

### 3.5 What to do with the `DATABASE_URL` the user supplied

Supplied: `postgresql://postgres:postgres@localhost:5432/doc_tayo?schema=public`.

It is the **superuser** and would make the running API the database superuser — contrary to the requirement. Proposed local values (all dev-only, never reused outside localhost):

```
DATABASE_URL=postgresql://doctayo_app:<dev-password>@localhost:5432/doc_tayo
DATABASE_MIGRATION_URL=postgresql://doctayo_owner:<dev-password>@localhost:5432/doc_tayo
```

The `postgres:postgres` pair is kept only as the Compose bootstrap superuser (`docker-compose.yml` env, local only). `.env.example` uses obvious placeholders; real `.env` stays gitignored. **`REQUIRES APPROVAL`** to change the supplied URL this way (§17-A2). I will not edit `.env` without confirmation.

### 3.6 Migration workflow

| Command (npm script) | Runs as | Purpose |
|---|---|---|
| `db:up` / `db:down` | — | `docker compose up -d postgres` / `down` |
| `db:generate` | — | `prisma generate` |
| `db:migrate:dev -- --name x` | owner | create + apply a migration locally |
| `db:migrate:deploy` | owner | apply committed migrations (CI, production) |
| `db:migrate:status` | owner | drift/status check |
| `db:test:reset` | owner | `prisma migrate reset --force --skip-seed` against `doc_tayo_test`, guarded to refuse any DB not ending `_test` |
| `db:studio` (optional, skip) | — | not added; avoid extra surface |

Rules: migrations are committed and reviewed; never edit an applied migration; raw SQL in migrations is allowed where Prisma cannot model something (exclusion constraints, `pg_trgm`) — later phases. Phase 1 produces **no domain migration**. Whether Prisma creates a baseline migration for an empty schema is part of the M2 spike; `migrate deploy` with zero migrations must be a clean no-op so CI is green.

### 3.7 Test database

`doc_tayo_test`, same server, owned by `doctayo_owner`, used by `doctayo_app`. A Vitest `globalSetup` (e2e/integration config):
1. Loads `.env.test`.
2. **Aborts if `DATABASE_URL`'s database name does not end with `_test`** (protects dev data).
3. Runs `prisma migrate deploy` with `DATABASE_MIGRATION_URL` (idempotent).
Per-file cleanup is added in Phase 2 when tables exist (e2e config runs files serially: `fileParallelism: false`).

---

## 4. Dependencies to Add (and why)

All versions to be pinned at implementation after re-checking the registry (and confirming each is ≥ 14 days old, per project policy). Checked today for Nest 12 compatibility:

| Package | Observed version / peer | Why it is needed |
|---|---|---|
| `@nestjs/config` | `12.1.1` (`@nestjs/common ^11 \|\| ^12`) | Master plan §2; centralized config. |
| `@nestjs/swagger` | `12.1.1` (`@nestjs/core ^12`, TS `^5.5 \|\| ^6`, needs `class-validator`+`class-transformer`) | OpenAPI at `/api/docs`. |
| `@nestjs/terminus` | `12.1.0` (`^11 \|\| ^12`) | Master plan §2 health checks. |
| `class-validator` | `0.15.1` | DTO validation + env validation. |
| `class-transformer` | `0.5.1` | `ValidationPipe({transform:true})`, env coercion. |
| `helmet` | `8.3.0` | Security headers. |
| `@prisma/client`, `@prisma/adapter-pg`, `prisma` | `7.10.1` | §3. |

**Deliberately not added:** ESLint (oxlint exists), `dotenv` (Node `loadEnvFile`), Joi/Zod (env validated with `class-validator`, already required), `@nestjs/throttler` (rate-limit policy is Phase 3 per brief), `@nestjs/jwt`, `nestjs-pino`/`pino` (Nest `Logger` + Observe is the master-plan choice), `uuid` (`node:crypto.randomUUID`), `testcontainers` (CI service container + Compose are sufficient), any Redis/queue package.

---

## 5. Target Structure After Phase 1

```
src/
  main.ts                    # thin: create app, applyAppSetup(app), listen
  app.setup.ts               # applyAppSetup(app): prefix, versioning, pipes, filter, helmet, CORS, swagger, shutdown
  app.module.ts              # Config, Observe(async), Prisma, Health
  config/
    app.config.ts  database.config.ts  cors.config.ts  logging.config.ts  observe.config.ts  swagger.config.ts
    env.validation.ts        # EnvironmentVariables class + validate()
    config.module.ts?        # (or inline in AppModule; decide in M3, prefer inline)
  common/
    errors/                  # error-codes.ts (catalog), domain-error.ts
    filters/                 # all-exceptions.filter.ts (+ mappers)
    http/                    # request-id.middleware.ts, request-logger.middleware.ts, request-id.util.ts
    dto/                     # response envelope types (ApiResponse<T>, ApiErrorResponse)
  prisma/                    # prisma.module.ts, prisma.service.ts
  modules/
    health/                  # health.module.ts, health.controller.ts, database.health.ts
  generated/prisma/          # gitignored
prisma/
  schema/base.prisma
  migrations/                # empty until Phase 2
scripts/db/
  bootstrap.sql  init/       # role + database + grant scripts
test/
  setup/                     # global-setup.ts, helpers (create-test-app.ts, log-capture.ts)
  *.e2e-spec.ts
docs/                        # environment, database, api-conventions, error-codes, architecture, adr/
docker-compose.yml  .env.example  .env.test.example  .nvmrc
.github/workflows/ci.yml
```

`applyAppSetup(app)` is the single function that applies every global (prefix, versioning, pipe, filter, helmet, CORS, Swagger). **E2E tests call the same function**, so tests exercise the real configuration instead of a hand-copied one — a frequent source of "works in test, broken in prod" for prefix/versioning/filter wiring.

Boilerplate removed in M4: `app.controller.ts`, `app.controller.spec.ts`, `app.service.ts`, and the Hello World e2e test (replaced by health tests).

---

## 6. Environment Configuration (`@nestjs/config`)

### 6.1 Design
- `ConfigModule.forRoot({ isGlobal: true, load: [app, database, cors, logging, swagger, observe], validate, ignoreEnvFile: NODE_ENV === 'production' })`. In production only real environment variables are used.
- **Validation**: an `EnvironmentVariables` class (class-validator decorators) + `validate(raw)` using `plainToInstance` + `validateSync` (`skipMissingProperties: false`, `whitelist` not applied — other env vars exist). Failure throws with the **names and constraint text of bad variables, never their values**. Startup aborts before any provider is created.
- **Namespaced typed configs** with `registerAs`; consumers inject typed config (`ConfigType<typeof databaseConfig>`), not `ConfigService.get('STRING')`.
- Cross-field rules in `validate()`: production requires `CORS_ALLOWED_ORIGINS` non-empty, `DATABASE_SSL != disable`, `SWAGGER_ENABLED` defaults false; wildcard origin forbidden when credentials enabled; Observe credentials required when `OBSERVE_ENABLED=true`.
- **Enforcement**: `process.env` is allowed only in `src/config/**`, `test/**`, `prisma.config.ts`, and root tool configs (§10).

### 6.2 Variables

| Variable | Req. | Default | Namespace | Notes |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | app | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | app | 1–65535 |
| `TRUST_PROXY` | no | `false` | app | `false`, number of hops, or `loopback`; matters for real client IPs behind a proxy (Phase 3 throttling, audit IP) |
| `DATABASE_URL` | **yes** | — | database | Runtime role (`doctayo_app`). Must be `postgresql://`. |
| `DATABASE_SCHEMA` | no | `public` | database | Passed to adapter |
| `DATABASE_SSL` | no | `disable` dev/test, `require` prod | database | `disable` \| `require` \| `verify-full`; `disable` rejected in production |
| `DATABASE_POOL_MAX` | no | `10` | database | |
| `DATABASE_MIGRATION_URL` | tooling | — | (not read by app) | Owner role; used by `prisma.config.ts`, CI, test setup. Not validated by the app (the runtime should not hold owner credentials in production). |
| `CORS_ALLOWED_ORIGINS` | prod | empty | cors | Comma-separated exact origins; empty = same-origin only |
| `CORS_ALLOW_CREDENTIALS` | no | `false` | cors | Flipped on in Phase 3 if httpOnly cookies are chosen (Q5) |
| `LOG_LEVEL` | no | `debug` dev, `log` prod, `error` test | logging | Nest levels |
| `LOG_FORMAT` | no | `pretty` dev, `json` prod | logging | |
| `SWAGGER_ENABLED` | no | `true` dev/test, **`false` prod** | swagger | master plan §2: not exposed in production |
| `OBSERVE_ENABLED` | no | `true` in production, otherwise `false` | observe | Avoids local/test traffic to the collector and test slowness (`shutdownFlushTimeout`) |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | if enabled | — | observe | Secrets; never logged |

### 6.3 Files
- `.env.example` (committed): every variable above, placeholder values only (`<set-me>` for secrets).
- `.env.test.example` (committed): pointing to `doc_tayo_test`, `OBSERVE_ENABLED=false`, `LOG_LEVEL=error`.
- `.env`, `.env.test` gitignored (`.gitignore` gets `.env.test`).
- `nest start --env-file .env` scripts remain; `ConfigModule` also reads `.env` outside production so `vitest`/other entry points behave identically.

---

## 7. API Foundation

Applied in `applyAppSetup` (used by `main.ts` and e2e tests):

1. `app.setGlobalPrefix('api')`.
2. `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })` → business routes resolve to **`/api/v1/<path>`**. Nest orders these as `prefix → version → controller path`, so the result is `/api/v1/...`, not `/v1/api/...`.
3. **Health is `VERSION_NEUTRAL`** (`@Controller({ path: 'health', version: VERSION_NEUTRAL })`) → exactly `/api/health` and `/api/health/ready` as required. This avoids `/api/v1/health`.
4. **Swagger** mounted with `SwaggerModule.setup('api/docs', app, document)` — Swagger's path is *not* automatically prefixed by the global prefix unless `useGlobalPrefix` is set; using the full `api/docs` explicitly avoids `/api/api/docs` and `/docs`. JSON at `/api/docs-json`. Only when `SWAGGER_ENABLED`. Document built from the actual controllers (health only in Phase 1) with title/version `v1`, `addServer`-free (relative).
5. **ValidationPipe** (global): `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`, `transformOptions: { enableImplicitConversion: false }` (explicit `@Type()` in DTOs; implicit conversion hides bugs), `stopAtFirstError: false`, custom `exceptionFactory` producing `VALIDATION_FAILED` with field details (§9).
6. **Body limit**: JSON 1 MB via the Express body-parser options (Nest `useBodyParser`); oversize → `413 PAYLOAD_TOO_LARGE`.
7. **Success shapes** (master plan §7.3): `{ data }` and `{ data, meta }`. Decision: **explicit return types, no global response-wrapping interceptor** — hidden response rewriting complicates Terminus output and Swagger. Phase 1 ships only the TypeScript types/Swagger helper (`ApiResponse<T>`, `PaginatedResponse<T>`); `PaginationQueryDto` is deferred to the first list endpoint (Phase 2). Health responses keep their own small body. `REQUIRES APPROVAL`: minor (§17-B2).
8. **Conventions documented** in `docs/api-conventions.md` (reference form of master plan §7): camelCase JSON, UUID ids, status code table, ISO-8601 UTC.

Initial endpoints described by Swagger: `GET /api/health`, `GET /api/health/ready` only (tagged `health`).

---

## 8. Request ID, Logging, and PHI Protection

### 8.1 Request ID
- Middleware `RequestIdMiddleware` (applied to all routes, first in the chain):
  - Accept inbound `X-Request-Id` **only if it is a canonical UUID** (regex); otherwise discard it and generate `crypto.randomUUID()`. (Strict format blocks log injection, oversized values and enumeration tricks. Trade-off: client-chosen opaque ids such as ULIDs are not echoed.)
  - Store on `req.requestId`, **overwrite** `req.headers['x-request-id']` with the sanitized value, and set the response header `X-Request-Id`.
- The error filter reads `req.requestId` → `error.requestId` (§9). The example `01J…` in the brief is a ULID; UUID is chosen instead because Observe already mints/accepts UUIDs as trace ids and Node supports it without a dependency. (`REQUIRES APPROVAL`, minor: §17-B3.)

### 8.2 Observe integration (verified against `@nestjs/observe@0.3.25` typings)
Observe's default `traceIdGenerator` is `req.headers['x-request-id'] || uuidv7()` — i.e. it would **trust an unvalidated client header** as trace id and log correlation id. Mitigation: pass `traceIdGenerator: (req) => req.requestId ?? <fresh uuid>` so Observe's trace id **is** our sanitized request id (`attachTraceIdToLogs` defaults to true → log lines carry it).

> Uncertain: execution order of Observe's HTTP instrumentation versus Nest middleware. **M5 includes a spike with a test**: send `X-Request-Id: not-a-uuid`; assert the logged trace id and response header are the generated UUID. Fallback if order is wrong: sanitize in a raw Express `app.use()` registered before Nest's router in `applyAppSetup` (runs earlier than module middleware).

`ObserveModule` switches from `forRoot` to **`forRootAsync`** (supported: `useFactory`/`inject` in options) reading the typed `observe` config, so no `process.env` remains in `app.module.ts`; `enabled` follows `OBSERVE_ENABLED`; `serviceVersion` from `OBSERVE_SERVICE_VERSION`/CI as Observe infers by default.

Hardening options (all exist in the installed typings):

| Option | Setting | Reason |
|---|---|---|
| `redaction` | `{ enabled: true, useDefaultPatterns: true, keys: [...] }` | Keys masked by name in log attributes, captured headers/bodies, and URL query strings: `password`, `currentPassword`, `newPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`, `authorization`, `cookie`, `setCookie`, `otp`, `secret`, `apiKey`, plus patient-data field names reserved now so later modules inherit protection: `firstName`, `lastName`, `middleName`, `birthDate`, `phone`, `address`, `email`, `diagnosis`, `notes`, `philhealthNumber`. (Default built-ins already cover bearer tokens, JWTs, `key=value` secrets, card numbers.) |
| `http.capture` | `{ body: false, headers: <explicit allow-list minus authorization/cookie> }` | Request bodies are PHI; capture is already off by default — set explicitly so it cannot drift. |
| `http.queryParamsObfuscateRegex` | mask `q`, `search`, `name`, `email`, `phone` | Search terms (`?q=Juan dela Cruz`) are PHI. |
| `forwardLogs` | `false` (default) — keep | Forwarding logs off-box is a deliberate Phase 7 decision after a log-content review. `REQUIRES APPROVAL` if you want it on earlier. |
| `sourceContext` | `false` | Default `true` uploads fragments of application source with captured errors. Not PHI, but it is data leaving the process; off until explicitly approved. `REQUIRES APPROVAL` (§17-B4). |
| `outgoing.database` | keep default (on) | Verified: statements are sent with every literal removed; bound parameters are never read. Still covered by the log-assertion tests. |
| `shutdownFlushTimeout` | `0` in test | Test suites must not wait on the collector. |

Residual risk (documented in `docs/security-privacy.md` input): Observe attaches error **messages and stacks** to traces. Redaction is pattern/key-based, so a free-text error message containing a patient name would not be caught. **Rule: error messages must be static strings; identifiers only, never values.** Enforced by review and by the `DomainError` design (§9).

### 8.3 Logging
- Nest `Logger` only. Format switch: `pretty` (dev) / `json` (prod) via the logger options (`ConsoleLogger` JSON mode — verify the option name in the installed Nest 12 at M5; fallback is a ~20-line custom `LoggerService` that emits one JSON line).
- `RequestLoggerMiddleware`: on `res.finish`, log **one line**: `method`, **route path without query string** (query strings may hold PHI), `statusCode`, `durationMs`, `requestId`. No headers, bodies, IP (IP logging is a Phase 3 audit decision), user agent.
- 5xx logged at `error` with the sanitized error (§9); 4xx at `warn`/`debug` without payload.
- **Never log** (documented list in `docs/security-privacy.md`/`docs/api-conventions.md`): request/response bodies; `Authorization`/`Cookie`/`Set-Cookie`; passwords, tokens, reset/OTP codes; query strings; any patient identifier values (names, birth dates, phone, address, government IDs, diagnoses, notes); connection strings and secrets; raw Prisma error text.

---

## 9. Errors and Exception Handling

### 9.1 Shape (per master plan §7.3 and the brief)
```json
{ "error": { "status": 400, "code": "VALIDATION_FAILED", "message": "Some fields need attention.",
  "details": [ { "field": "email", "code": "INVALID_FORMAT", "message": "Please provide a valid email address." } ],
  "requestId": "…" } }
```
`details` is omitted when empty.

### 9.2 Components
- `common/errors/error-codes.ts` — a single `const` object/enum: `code → { status, defaultMessage }`. Source of truth for `docs/error-codes.md` (a unit test asserts every code in the catalog appears in the doc and vice versa — prevents doc drift).
- `common/errors/domain-error.ts` — `class DomainError extends Error { constructor(code: ErrorCode, opts?: { message?: string; details?: FieldError[] }) }`. Status comes from the catalog. **This is the only custom error class**; it is a thin wrapper, not a framework. Services throw it for business rules (used from Phase 2 on; Phase 1 only needs it for tests and the filter's contract).
- `common/filters/all-exceptions.filter.ts` — one `@Catch()` filter registered via `app.useGlobalFilters` (in `applyAppSetup`, so it is not DI-dependent and works in tests identically). Mapping order:
  1. `DomainError` → catalog status/code.
  2. Validation (marker thrown by the `ValidationPipe` `exceptionFactory`) → `400 VALIDATION_FAILED` + `details`.
  3. Body-parser errors (`entity.parse.failed` → `400 MALFORMED_JSON`; `entity.too.large` → `413 PAYLOAD_TOO_LARGE`; unsupported charset/encoding → `415 UNSUPPORTED_MEDIA_TYPE`).
  4. Nest `HttpException`: `NotFoundException` on an unmatched route → `404 ROUTE_NOT_FOUND`; `ServiceUnavailableException` (Terminus) → `503 NOT_READY` (**no health detail payload is forwarded to the client**; details are logged server-side); other statuses mapped to the closest catalog code (`401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `405`, `409 CONFLICT`, `429 RATE_LIMITED`) with the catalog message — **the HttpException's own message is not trusted** (it may be developer text).
  5. Prisma known errors: `P2002` → `409 CONFLICT_UNIQUE`; `P2025` → `404 NOT_FOUND`; `P2003`/`P2014` → `409 CONFLICT_REFERENCE`; connection/initialization/timeouts (`P1001`, `P1002`, `P1008`, `P1017`, `PrismaClientInitializationError`) → `503 SERVICE_UNAVAILABLE`; any other Prisma error → `500 INTERNAL_ERROR`. `meta` (column names, constraint targets) is **not** returned (it can reveal schema); logged server-side only.
  6. Anything else → `500 INTERNAL_ERROR`, generic message, `requestId` included.
- Logging inside the filter: 5xx logs `{ requestId, errorName, code }` plus the stack through the logger (server-side only, redacted by Observe). Client body never contains `stack`, SQL, Prisma `meta`, hostnames, or connection strings.
- Express 5 note (to verify at M6): errors from body-parser reach Nest's filter as plain errors with `type`/`status` properties, hence the explicit mapping in step 3.

### 9.3 Validation detail mapping
A small, closed map from class-validator constraint keys to stable field-level codes: `isEmail/isUUID/matches/isDateString/isIn/isEnum → INVALID_FORMAT`, `isNotEmpty/isDefined → REQUIRED`, `min/max/minLength/maxLength/arraySize → OUT_OF_RANGE`/`TOO_SHORT`/`TOO_LONG`, `isString/isInt/isBoolean… → INVALID_TYPE`, `whitelistValidation → UNKNOWN_FIELD`; unmapped constraints → `INVALID_VALUE`. Nested errors flatten to dotted paths (`address.city`, `items[0].id`). Field messages are friendly generic text per code (not class-validator's English default), so the frontend can replace them by `code`.

### 9.4 Initial catalog (documented in `docs/error-codes.md`)
Active in Phase 1: `VALIDATION_FAILED`, `MALFORMED_JSON`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `ROUTE_NOT_FOUND`, `NOT_FOUND`, `CONFLICT_UNIQUE`, `CONFLICT_REFERENCE`, `NOT_READY`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`.
Reserved (cataloged so the shape is stable; no producer until noted): `UNAUTHENTICATED`, `FORBIDDEN` (Phase 3/4), `RATE_LIMITED` (Phase 3), `CONFLICT` (generic). Field-level codes: `REQUIRED`, `INVALID_FORMAT`, `INVALID_TYPE`, `INVALID_VALUE`, `OUT_OF_RANGE`, `TOO_SHORT`, `TOO_LONG`, `UNKNOWN_FIELD`.
Rule: codes are append-only; renaming a code is a breaking API change.

---

## 10. Security Headers, CORS, and Code-Quality Enforcement

### 10.1 HTTP security (in `applyAppSetup`)
- **Helmet** with defaults; `strictTransportSecurity` only when `NODE_ENV=production` (assumes TLS terminates at the proxy; `TRUST_PROXY` set correspondingly). `x-powered-by` removed (Helmet + `app.disable`).
- **Swagger UI vs CSP**: Helmet's default CSP blocks Swagger UI's inline assets. Relax CSP **only for the `/api/docs` path** (non-production, since docs are disabled in production) — apply a path-scoped Helmet instance or a docs-specific CSP; a test asserts the strict CSP still applies to API routes.
- **CORS** from config: exact-match origin allow-list (function origin callback); methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`; allowed headers `Content-Type, Authorization, X-Request-Id, Idempotency-Key`; exposed headers `X-Request-Id`; `maxAge` 600 s; `credentials` only from `CORS_ALLOW_CREDENTIALS`; **validation forbids credentials + wildcard**. Disallowed origins receive no CORS headers (browser blocks), no error body. Empty list = no cross-origin access.
- Not added in Phase 1: rate limiting, auth, tenant guards, cookie parser (Phase 3, Q5).

### 10.2 Lint and static enforcement (oxlint stays)
Verified experimentally on oxlint `1.93`:
- ✅ `no-restricted-globals` works → ban the global `process` across `src/` and allow it by `overrides` only for `src/config/**`, `**/*.spec.ts`, `**/*.e2e-spec.ts`, `test/**`. This enforces "no `process.env` outside config" mechanically (it is slightly stricter: all of `process`, which is intended; `process.on(...)` hooks, if ever needed, live in `main.ts` via an explicit override).
- ✅ `no-restricted-imports` available (e.g., forbid importing `src/generated/prisma` outside `src/prisma/**` and `src/modules/**/…repository` — **not enabled in Phase 1**; the tenant-scoped client rule is Phase 2).
- ❌ `no-restricted-syntax` does **not** exist in oxlint 1.93 (tested: "Rule not found"), so `$queryRawUnsafe` cannot be banned by a lint rule. **Substitute: a Vitest architecture test** `test/architecture/forbidden-patterns.spec.ts` that scans `src/**/*.ts` for `$queryRawUnsafe` / `$executeRawUnsafe` (and `console.log`, `process.env` outside config as a second line of defense) and fails with the offending file/line. Runs in the normal unit suite and in CI.
- `typescript/no-floating-promises` stays `error`. Additional oxlint rules enabled only if clearly justified: `no-console` (use Nest `Logger`), `eqeqeq`, `typescript/no-explicit-any` stays off (existing setting; Prisma/Express interop). No wholesale ruleset changes.
- Prettier unchanged. `npm run format:check` added for CI parity (`prettier --check`).

### 10.3 TypeScript and conventions
- Keep `strict: true`; add nothing risky. Consider `noImplicitOverride` and `noUncheckedIndexedAccess` — **not** enabled now (churn vs. benefit; revisit in Phase 2 when domain code starts). Documented in ADR-0002 as an explicit non-decision.
- ESM: relative imports end in `.js`; no `__dirname`; `import type` for type-only imports where `isolatedModules` requires.
- Naming: files `kebab-case.<role>.ts` (`prisma.service.ts`, `create-patient.dto.ts`); classes `PascalCase`; DB `snake_case` via `@map` (Phase 2+); env vars `SCREAMING_SNAKE`; error codes `SCREAMING_SNAKE`.
- Tests: unit `*.spec.ts` beside code; e2e/integration `*.e2e-spec.ts` in `test/`.
- Scripts (final set in M1/M10): `build`, `start*`, `lint`, `format`, `format:check`, `typecheck` (`tsc --noEmit -p tsconfig.json`), `test`, `test:cov`, `test:e2e`, `db:*`, `prebuild`/`pretypecheck`/`pretest`/`pretest:e2e` → `prisma generate` so a clean checkout always works. `postinstall` (Prisma 8 skills) removed.

---

## 11. Health Endpoints

`modules/health` using `@nestjs/terminus` (`12.1.0`):

| Route | Purpose | Behavior |
|---|---|---|
| `GET /api/health` | Liveness | `200 { "status": "ok" }`. **No dependency checks** (a DB outage must not restart the process). |
| `GET /api/health/ready` | Readiness | Runs a real `SELECT 1` through `PrismaService` with a **1 s timeout**; `200 { "status": "ok", "info": { "database": { "status": "up" } } }`; on failure `503` with the standard error shape (`NOT_READY`). |

Decision: write a ~15-line `DatabaseHealthIndicator` (using `HealthIndicatorService`) around tagged `` this.prisma.$queryRaw`SELECT 1` `` rather than Terminus's bundled `PrismaHealthIndicator`. The bundled one calls `$queryRawUnsafe` internally; our own forbidden-pattern test (and policy) bans that call in our codebase, and a custom indicator also lets us guarantee **no error text** (which could contain host/credentials) reaches the response — the indicator reports only `up`/`down`.
Responses never include connection strings, hostnames, driver messages, or versions.
`@Public()` tagging for health happens in Phase 3 when the global JWT guard is introduced (noted in `docs/architecture.md`).

---

## 12. Test Strategy for Phase 1

Stack: Vitest 4 + supertest + `@nestjs/testing`; real PostgreSQL (`doc_tayo_test` locally and a service container in CI). **Prisma is not mocked** for any test that claims database behavior. Pure functions (env validation, request-id util, error mapper tables) are unit-tested without Nest.

| # | Requirement | Type | Test (file) | Assertion |
|---|---|---|---|---|
| 1 | Startup with valid env | e2e | `test/startup.e2e-spec.ts` | App created via `createTestApp()` boots; `GET /api/health` → 200 |
| 2 | Startup fails on invalid env | unit | `src/config/env.validation.spec.ts` | Missing `DATABASE_URL`, bad `PORT`, `NODE_ENV=production` w/o CORS origins, `DATABASE_SSL=disable` in prod, wildcard+credentials, Observe enabled w/o keys → each throws; message lists variable **names**, **not values** (use a distinctive secret value and assert it is absent). Plus e2e: `Test.createTestingModule({imports:[AppModule]})` with bad env rejects `compile()` |
| 3 | PostgreSQL connection | integration | `test/database.e2e-spec.ts` | `PrismaService` connects; `SELECT 1` works; `current_user = 'doctayo_app'`; role is not superuser, no `bypassrls` |
| 4 | Runtime role is least privilege | integration | same | `CREATE TABLE` in `public` as `doctayo_app` is rejected (`42501`); owner URL succeeds in a temp-table-in-transaction check (rolled back) |
| 5 | Readiness up | e2e | `test/health.e2e-spec.ts` | `/api/health/ready` → 200, body has `database.up`, no URL/host strings |
| 6 | Readiness down | e2e | same | Build app with `DATABASE_URL` pointing to a closed port, or call `prisma.$disconnect()` + stop connection (via a second app instance with bad port; avoid stopping the shared DB) → `/ready` 503, standard error body `NOT_READY`, **no** host/port/credentials in body; `/api/health` liveness still 200 |
| 7 | Global prefix + versioning | e2e | `test/api-conventions.e2e-spec.ts` | A **test-only** controller (`@Controller({path:'_test', version:'1'})`, registered only in the test module) answers at `/api/v1/_test`; 404 at `/_test`, `/v1/_test`, `/api/_test`, `/api/api/...`, `/api/v1/v1/...`; health at `/api/health` and **not** `/api/v1/health` |
| 8 | DTO validation + unknown properties | e2e | same | Test controller with a DTO: valid → 201; missing/invalid → 400 `VALIDATION_FAILED` with `details[].field/code`; extra property → 400 with `UNKNOWN_FIELD`; wrong types not coerced; nested field paths |
| 9 | Error structure | e2e | `test/errors.e2e-spec.ts` | Every non-2xx has exactly `{error:{status,code,message,requestId[,details]}}`; unknown route → `ROUTE_NOT_FOUND`; malformed JSON → `MALFORMED_JSON`; >1 MB → `PAYLOAD_TOO_LARGE`; wrong content-type → `UNSUPPORTED_MEDIA_TYPE`; `DomainError` → catalog code/status; Prisma `P2002`/`P2025` thrown from a test route → 409/404 |
| 10 | Unexpected exceptions don't leak | e2e | same | Test route throws `new Error('secret-sql SELECT * FROM x postgres://u:pw@h/db')` and a Prisma-shaped error with `meta` → 500 `INTERNAL_ERROR`, generic text; response body contains none of: `stack`, `SELECT`, `postgres://`, `meta`, `node_modules`, `prisma`, the secret string |
| 11 | Request ID propagation | e2e + unit | `test/request-id.e2e-spec.ts`, util spec | No header → generated UUID in response header, equals `error.requestId`; valid UUID header → echoed; invalid / overlong / newline-containing / non-UUID header → replaced by generated UUID; same id appears in the captured log line; (Observe trace-id spike assertion) |
| 12 | Swagger availability | e2e | `test/swagger.e2e-spec.ts` | `SWAGGER_ENABLED=true`: `/api/docs` 200 HTML, `/api/docs-json` lists `/api/health` and `/api/health/ready`, no `/api/api/…` keys; `SWAGGER_ENABLED=false` (and `NODE_ENV=production` default): both 404 |
| 13 | Security headers | e2e | `test/security.e2e-spec.ts` | API responses carry `x-content-type-options: nosniff`, CSP, `x-frame-options`/frame-ancestors, no `x-powered-by`; HSTS only under production config; docs path has relaxed CSP while API path keeps strict |
| 14 | CORS | e2e | same | Allowed origin: preflight 204 with `access-control-allow-origin` = that origin, `Vary: Origin`, correct methods/headers; disallowed origin: no `access-control-allow-origin`; no wildcard; credentials header present only when enabled; `X-Request-Id` exposed |
| 15 | Logging and PHI redaction | e2e | `test/logging.e2e-spec.ts` | Capture all Nest `Logger` output (custom `LoggerService` collecting strings). Send requests with: JSON body containing `password`, `firstName`, a distinctive PHI marker; `Authorization: Bearer <jwt-shaped>`; `Cookie`; `?q=<PHI marker>`; and a route that throws an error whose text includes a token. Assert none of those marker strings appear in any captured log line nor in any response body. Assert exactly one access-log line per request with method/path/status/duration/requestId and **no query string** |
| 16 | Observe config hardening | unit | `src/config/observe.config.spec.ts` | Built Observe options: `redaction.enabled`, key list contains the mandatory keys, `http.capture.body === false`, headers allow-list excludes `authorization`/`cookie`, `forwardLogs` false, `sourceContext` false, `enabled` follows config; with `OBSERVE_ENABLED=false` no network is attempted |
| 17 | Forbidden patterns | unit | `test/architecture/forbidden-patterns.spec.ts` | No `$queryRawUnsafe`/`$executeRawUnsafe`/`process.env` (outside config)/`console.*` in `src/` |
| 18 | Error-catalog docs in sync | unit | `src/common/errors/error-codes.spec.ts` | Catalog codes ⇔ `docs/error-codes.md` |
| 19 | Migrations apply cleanly | CI | workflow step | `prisma migrate deploy` exits 0 on a clean DB; `prisma migrate status` clean |

Shared helpers (`test/setup/`): `createTestApp({ env?, extraControllers? })` (builds `AppModule`, calls the real `applyAppSetup`), `captureLogs()`, `global-setup.ts` (loads `.env.test`, refuses non-`_test` DB names, runs `migrate deploy`). E2E config: `fileParallelism: false`, `globalSetup`, `setupFiles` for env. Observe is disabled in tests (`OBSERVE_ENABLED=false`, `shutdownFlushTimeout: 0`).

---

## 13. CI (GitHub Actions)

`.github/workflows/ci.yml`, triggers: `pull_request`, `push` to `main`/`master`. Permissions `contents: read`. `concurrency` cancels superseded runs. Node from `.nvmrc` (`24`), `engines` field added to `package.json` (`>=24`). Actions pinned to **commit SHAs** (supply-chain hygiene) — SHAs resolved at implementation time.

Single job `verify` (fast enough not to need a matrix):
1. `actions/checkout`
2. `actions/setup-node` with `cache: npm`
3. `npm ci` (lockfile enforced)
4. `npm run db:generate`
5. `npm run lint` and `npm run format:check`
6. `npm run typecheck`
7. `npm test` (unit; includes architecture and env-validation tests, no DB needed)
8. Provision DB: `services.postgres` (`postgres:17`, env bootstrap superuser, healthcheck `pg_isready`) → step runs `scripts/db/bootstrap.sql` via `psql` as the superuser to create roles, `doc_tayo_test` and grants — the **same script used locally**, so CI exercises the real role setup.
9. `npm run db:migrate:deploy` (owner URL, test DB)
10. `npm run test:e2e` with env: `DATABASE_URL` (app role), `DATABASE_MIGRATION_URL` (owner role), `NODE_ENV=test`, CORS/log settings, `OBSERVE_ENABLED=false`. CI-only passwords are throwaway values defined in the workflow (the DB lives and dies with the job); no repository secrets needed in Phase 1.
11. `npm run build` (confirms `nest build` works with the generated client).

Separate non-blocking job `audit`: `npm audit --omit=dev --audit-level=high` (master plan §8.18); made blocking once baseline noise is understood.

Clean-checkout reliability: nothing depends on a pre-existing `.env`; `prisma generate` is explicit; DB is created from scratch every run.

---

## 14. Scope Boundaries (what Phase 1 must NOT contain)

No tenant/branch/membership tables or code; no `users`, `sessions`, JWT, password hashing, `@Public()`/guards/`RequestContext`/tenant extension; no roles/permissions/audit tables; no patient/doctor/staff/appointment/clinical/billing modules; no throttler/lockout policy; no cookie parser; no `AsyncLocalStorage` context (Phase 2 — Phase 1 correlates only through the request id on `req` plus Observe's trace id). Test-only controllers live under `test/` and are never imported by `src/`.

Forward-compatibility checks built into the design: PrismaService is a plain extendable client (Phase 2 `$extends`); schema folder is multi-file; roles are already least-privilege/NOBYPASSRLS (RLS option); error catalog already reserves `UNAUTHENTICATED`/`FORBIDDEN`; `applyAppSetup` is the single place Phase 2–3 add guards/pipes; `req.requestId` gives Phase 2's audit service a request id to store.

---

## 15. Implementation Milestones

Each milestone is one reviewable commit, leaves `lint`, `typecheck`, `test` and `test:e2e` green, and must not start before the previous one is complete.

### M0 — Approvals and cleanup preparation
- **Objective:** resolve §17 items A1–A3 before touching dependencies.
- **Files:** none.
- **Verification:** written approval of Q1 side-effects, DB URL change, Prisma 8 skills deletion.
- **Done when:** decisions recorded.

### M1 — Tooling baseline and Prisma 7 alignment
- **Objective:** a coherent, pinned dependency set; no mixed Prisma majors.
- **Files:** `package.json`, `package-lock.json`, `prisma.config.ts`, `.gitignore`, `.nvmrc`, (delete Prisma 8 skill dirs if approved).
- **Dependencies:** pin `prisma@7.10.1`, `@prisma/client@7.10.1`, `@prisma/adapter-pg@7.10.1`; remove `postinstall`; add `engines`, scripts `typecheck`, `format:check`.
- **Details:** clean `node_modules` + reinstall from the new lockfile so `@prisma/composer*` and Prisma 8 artifacts disappear. `.gitignore` += `/src/generated`, `.env.test`.
- **Verify:** `npm ls prisma @prisma/client @prisma/adapter-pg` all `7.10.1`; baseline `lint`, `typecheck`, `test`, `test:e2e` still pass (Hello World still present).
- **Done when:** one version of every Prisma package, no RC in `package-lock.json` (`grep -c "8.0.0-rc"` = 0).

### M2 — Local PostgreSQL, roles, and Prisma schema skeleton
- **Objective:** a reproducible dev/test database with owner/app roles; Prisma CLI works against it.
- **Files:** `docker-compose.yml`, `scripts/db/bootstrap.sql`, `scripts/db/init/*`, `prisma/schema/base.prisma`, `prisma.config.ts`, `.env.example`, `.env.test.example`, npm `db:*` scripts.
- **Details:** §3.1–3.4, 3.6. Spike items: empty-schema `generate`/`migrate deploy`; Prisma 7 `.env` loading; `prisma-client` generator ESM output options; `?schema=` removal.
- **Verify:** `docker compose up -d` healthy; `psql` as `doctayo_app` can connect but `CREATE TABLE` fails; as `doctayo_owner` succeeds (in a rolled-back transaction); `npm run db:generate` produces `src/generated/prisma`; `npm run db:migrate:deploy` exits 0; `nest build` succeeds; bootstrap script re-run is idempotent (run twice).
- **Done when:** the above pass on a fresh volume (`docker compose down -v && up`).

### M3 — Configuration layer
- **Objective:** validated, namespaced config; no `process.env` outside `src/config`.
- **Files:** `src/config/*`, `src/app.module.ts` (ConfigModule + Observe `forRootAsync`), `docs/environment.md`, `.env.example` finalized.
- **Details:** §6; refactor `app.module.ts` Observe wiring to typed config; `main.ts` reads `PORT` from config.
- **Tests:** #2 (unit + boot failure), #16 (partially, defaults).
- **Done when:** missing/invalid variables abort boot with name-only messages; oxlint `no-restricted-globals` rule added and passing.

### M4 — Application setup, API prefix/versioning, Swagger, boilerplate removal
- **Objective:** `applyAppSetup`, prefix/versioning, ValidationPipe, Swagger, body limit; delete Hello World.
- **Files:** `src/app.setup.ts`, `src/main.ts`, `src/swagger/*` or inside setup, delete `app.controller.ts`, `app.service.ts`, `app.controller.spec.ts`, replace `test/app.e2e-spec.ts`; `test/setup/create-test-app.ts`.
- **Details:** §7. Temporary: Swagger renders with no operations until M7 lands health (acceptable for the milestone's own tests via the test-only controller).
- **Tests:** #7, #8 (with default Nest error shape until M6), #12 (docs on/off).
- **Done when:** routes live exactly at `/api/v1/...`; docs at `/api/docs` and `/api/docs-json`; no duplicated segments; no starter code remains.

### M5 — Request ID, access log, logging format, Observe hardening
- **Objective:** correlation and PHI-safe logging.
- **Files:** `src/common/http/*`, `src/config/observe.config.ts`, `src/app.module.ts`, `docs/security-privacy.md` (logging rules section — or placed in `docs/api-conventions.md` if you prefer not to create the file early).
- **Details:** §8. Contains the middleware-order spike; decide fallback to raw Express middleware if needed. Verify Nest 12 JSON logger option.
- **Tests:** #11, #15, #16.
- **Done when:** malformed `X-Request-Id` is never reflected or logged; log capture shows no PHI markers; Observe trace id equals request id (or documented fallback implemented).

### M6 — Error handling
- **Objective:** one consistent error shape everywhere.
- **Files:** `src/common/errors/*`, `src/common/filters/*`, `applyAppSetup`, `docs/error-codes.md`.
- **Details:** §9 — catalog, `DomainError`, filter, validation `exceptionFactory` + detail mapper, Prisma/body-parser mapping. Verify Express 5 body-parser error shapes against the installed versions.
- **Tests:** #8 (final shape), #9, #10, #18.
- **Done when:** no response path (including 404, 413, JSON parse, validation, Prisma, unknown) produces a non-standard body or leaks internals.

### M7 — Prisma module, database startup check, health endpoints
- **Objective:** DB connectivity wired into the app; liveness and readiness.
- **Files:** `src/prisma/*`, `src/modules/health/*`, `src/app.module.ts`, `docs/database.md`.
- **Details:** §3.2, §3.4 startup role check, §11. Depends on M2 (DB), M3 (config), M6 (error shape for 503).
- **Tests:** #3, #4, #5, #6, plus health in Swagger (#12 final).
- **Done when:** app boots against Postgres; readiness fails (503, standard body, no leaks) when the DB is unreachable and recovers when it is back; liveness unaffected; running as superuser is refused in production config.

### M8 — HTTP security: Helmet, CORS, shutdown hooks
- **Objective:** hardened HTTP surface.
- **Files:** `applyAppSetup`, `src/config/cors.config.ts` (finalized), tests.
- **Details:** §10.1; Swagger-only CSP relaxation; `enableShutdownHooks`; `TRUST_PROXY`.
- **Tests:** #13, #14.
- **Done when:** header/CORS matrices pass; docs UI actually renders in a manual browser check (record result in PR); strict CSP on API routes.

### M9 — Lint enforcement and architecture tests
- **Objective:** make the conventions mechanical.
- **Files:** `.oxlintrc.json` (overrides for `process`, `console`), `test/architecture/forbidden-patterns.spec.ts`.
- **Tests:** #17; plus negative proof — temporarily add a violating line locally and confirm both oxlint and the test fail (not committed).
- **Done when:** violations fail `npm run lint` / `npm test`; current code passes.

### M10 — CI pipeline
- **Objective:** clean-checkout CI as in §13.
- **Files:** `.github/workflows/ci.yml`, `package.json` scripts, `test/setup/global-setup.ts`.
- **Verify:** workflow lint (`actionlint` if available) and a real run on a pushed branch; a deliberately failing test turns CI red (then reverted); migrations step proven on a clean database.
- **Done when:** green run on a clean checkout; all five required stages executed; E2E hit real Postgres (#19).

### M11 — Documentation and ADRs
- **Objective:** concise, accurate docs matching the implementation.
- **Files:** `README.md` (replace the default Nest README with project quick start), `docs/environment.md`, `docs/database.md`, `docs/api-conventions.md`, `docs/error-codes.md`, `docs/architecture.md`, `docs/adr/0001-prisma-version.md`, `0002-typescript-strictness-deferral.md`, `0003-roles-owner-vs-runtime.md`, `0004-request-id-and-observe-trace-id.md`, `0005-error-envelope-and-no-response-interceptor.md`, `0006-oxlint-and-forbidden-pattern-tests.md`.
- **Verify:** follow README from a fresh clone/volume in a scratch directory (copy `.env.example`, `docker compose up`, `npm ci`, `npm run db:migrate:deploy`, `npm run start:dev`, hit endpoints); `error-codes.spec` guards the catalog doc.
- **Done when:** a new developer reaches a running `/api/health/ready` using only the README.

### M12 — Phase 1 acceptance
Run the master plan's completion criteria (§16) end to end and record evidence in the PR description.

---

## 16. Phase 1 Completion Criteria (from master plan, made testable)

| Master plan criterion | Evidence |
|---|---|
| `npm run start:dev` boots against Postgres | M7 manual run + test #1/#3 |
| Invalid env fails fast | test #2 |
| `/api/health/ready` checks DB | tests #5/#6 |
| Swagger renders | test #12 + manual browser check |
| CI is green | M10 run |
| A deliberate error returns the standard shape without internals | tests #9/#10 |
| Additional (this plan): runtime role is not owner/superuser; no PHI in logs; request ids sanitized | tests #4, #15, #11 |

---

## 17. Open Decisions and Approvals

**A — Blocking (needed before M1/M2)**
- **A1 (Q1):** Confirm Prisma **7.10.1** (exact pins) and dropping Prisma 8 RC. *Recommended: approve.*
- **A2:** Change the supplied superuser `DATABASE_URL` into two non-superuser role URLs (`doctayo_app` runtime, `doctayo_owner` migrations), keeping `postgres:postgres` only as the Compose bootstrap superuser; drop `?schema=public` from the runtime URL (schema set in code). Role names `doctayo_owner`/`doctayo_app` acceptable? I will not modify `.env` unless told to.
- **A3:** Delete the untracked Prisma 8 agent-skill folders (`.agents/`, `.claude/skills/prisma-*`, `.cursor/`, `.devin/`) and remove `prisma skills sync` from `postinstall`? They document Prisma Composer/Platform APIs this project will not use. (`.claude/` may hold other local settings — only the `skills/prisma-*` subfolders would be removed.)

**B — Needed by the milestone indicated (defaults proposed)**
- **B1 (Q4, before Phase 7):** Hosting provider/region. Phase 1 is provider-neutral.
- **B2 (M4):** No global `{ data }` response-wrapping interceptor; endpoints return explicit `{ data }` shapes. *Recommended.*
- **B3 (M5):** Request IDs are UUIDs (not ULIDs as in the brief's example); only canonical UUID inbound ids are honored.
- **B4 (M5):** Observe `sourceContext: false` (no source snippets leave the process) and `forwardLogs: false` for now; `OBSERVE_ENABLED` default off outside production.
- **B5 (M3):** Swagger disabled by default in production (`SWAGGER_ENABLED=false`); the master plan allowed "non-production only (or behind auth)".
- **B6 (M10):** CI trigger branches (`main`/`master`) and whether to pin actions by SHA (recommended).
- **B7 (M1):** Node floor `>=24` in `engines`/`.nvmrc`. Currently running Node 24.22.2; Prisma 7.10.1 allows `^20.19 || ^22.12 || >=24`, so a lower floor is possible if production Node is older.

**Open technical uncertainties (spikes inside milestones, not approvals)**
1. Empty-schema `prisma generate`/`migrate` behavior (M2). 2. Prisma 7 `.env` loading and `prisma-client` generator ESM output options (M2). 3. Observe middleware order vs. request-id sanitization (M5). 4. Nest 12 JSON logger option name (M5). 5. Express 5 body-parser error shapes in the filter (M6). 6. Terminus `HealthIndicatorService` API details (M7). 7. Swagger UI CSP workaround specifics (M8).

---

## 18. Self-Validation Against the Master Plan

| Check | Result |
|---|---|
| Every Phase 1 deliverable in master plan §10 covered | Prisma version (M1), PostgreSQL local + test DB (M2), `PrismaService` (M7), validated config (M3), prefix + versioning (M4), `ValidationPipe` (M4), exception filter + catalog (M6), request id (M5), Helmet + CORS (M8), Swagger (M4), health (M7), Observe PHI redaction (M5), DB roles (M2/M7), lint rules (M9), CI (M10), remove Hello World (M4) — all mapped |
| Q1 and Q4 addressed | §2 |
| No later-phase business functionality | §14; test-only controllers stay in `test/` |
| Compatible with multi-tenancy/auth | Extendable `PrismaService`, multi-file schema, NOBYPASSRLS/non-owner runtime role, reserved error codes, single `applyAppSetup`, request id on `req` |
| Every milestone has testable completion criteria | §15 |
| No unnecessary technologies/abstractions | §4 "not added" list; one error class; no response interceptor; no ESLint, dotenv, pino, testcontainers |
| Master-plan deviations (flagged) | (1) Health readiness uses a custom indicator instead of Terminus's bundled Prisma indicator (it uses `$queryRawUnsafe`); (2) `$queryRawUnsafe` ban implemented as an architecture test because oxlint lacks `no-restricted-syntax`; (3) request id is a UUID; (4) ESLint not introduced although the brief mentions it, because oxlint is already the project linter |

---

## 19. Implementation Status and Deviations (recorded after execution)

All milestones M1–M11 were executed; every §12 test exists and passes (69 unit/architecture + 42 e2e). Approval items were resolved with the recommended defaults (A1 Prisma 7.10.1, A2 role split, A3 Prisma 8 skill folders deleted, B2–B7 as proposed).

Deviations from the plan as written:

| Area | Plan said | What was done / why |
|---|---|---|
| Local database | Docker Compose PostgreSQL | **Removed at the user's request**: the project uses the existing PostgreSQL 16 server on `localhost:5432` and its pre-created `doc_tayo`. Roles and `doc_tayo_test` are created there by `npm run db:bootstrap`. Docker was then **re-added at the user's request** as a learning/deployment tool: multi-stage `Dockerfile` (runtime + migrate targets), `docker-compose.yml` (API against the host Postgres, plus an optional `isolated` profile with its own Postgres on host port 5434), `docs/docker.md`, a CI image-build job. The Phase 7 "Dockerfile" deliverable is therefore done early. CI still uses a Postgres service container. |
| `prisma migrate reset` | `--skip-seed` | Flag removed in Prisma 7. Also Prisma gates `reset` behind explicit user consent, so it was **not run**; `db:test:reset` exists but is unverified, and whether reset drops the runtime role's grants is unverified (docs say to re-run `bootstrap.sql`). |
| Config validation | `ConfigModule.validate` | Validation runs lazily when each namespace is built (still before the app serves traffic, still aborts startup). Needed so e2e tests can boot apps with different environments. |
| Generic 400 | `VALIDATION_FAILED` | Added catalog code `BAD_REQUEST` for non-validation 400s. |
| Unmatched routes | Filter handles them | Nest only 404s under the global prefix, so `applyPostInit(app)` (called after `init()`) adds a last handler. |
| Charset test | `utf-32` | body-parser accepts UTF-32; the test uses `iso-8859-1` (→ 415). |
| Readiness-down test | real outage | Boot with an unreachable DB is tested for real (app refuses to start); readiness failure is tested by making the query reject, because the pool otherwise reconnects. |
| Observe trace id = request id | spike in M5 | **Not verifiable without collector credentials.** With Observe disabled, log lines carry Observe's own `traceId` and our `requestId` separately. Correlation works via `requestId` regardless. Recorded in `docs/security-privacy.md`. |
| HSTS e2e test | test in production mode | Skipped: production config requires TLS to the database. |
| npm install scripts | — | npm now gates install scripts: `@prisma/engines` and `prisma` approved, `@scarf/scarf` (telemetry) denied, recorded in `package.json` `allowScripts`. |
| Dependencies | listed in §4 | Same; `@nestjs/config`, `@nestjs/swagger`, `@nestjs/terminus`, `class-validator`, `class-transformer`, `helmet` use caret ranges, Prisma packages are exact. |
