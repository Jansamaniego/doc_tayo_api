# DocTayo API

Backend for DocTayo, a multi-tenant clinic management system. NestJS 12 · TypeScript (ESM) · Prisma 7 · PostgreSQL 17 · REST under `/api/v1`.

The master roadmap is [`plan.md`](plan.md); this repository is currently at the end of **Phase 1 (project foundation)**, specified in [`plans/00-project-foundation.md`](plans/00-project-foundation.md). Frontend work lives in a separate project.

## Quick start

Requirements: Node ≥ 24 (see `.nvmrc`), PostgreSQL ≥ 15 on `localhost:5432` with an admin login (e.g. `postgres`) and a database named `doc_tayo`, and the `psql` client.

```bash
npm ci
cp .env.example .env            # then fill in Observe keys if you use them
cp .env.test.example .env.test
DB_ADMIN_URL=postgresql://postgres:<password>@localhost:5432/postgres npm run db:bootstrap   # once: roles, doc_tayo(_test), grants
npm run db:generate             # Prisma client -> src/generated (gitignored)
npm run db:migrate:deploy       # no-op until Phase 2 adds models
npm run start:dev
```

Check it works:

```bash
curl localhost:3000/api/health        # liveness
curl localhost:3000/api/health/ready  # readiness (real PostgreSQL query)
open http://localhost:3000/api/docs   # Swagger UI (non-production)
```

## Scripts

| Script | Purpose |
|---|---|
| `start:dev` / `start` / `start:prod` | Run with watch / once / compiled |
| `build` | Generate the Prisma client and compile |
| `lint`, `format`, `format:check`, `typecheck` | oxlint (type-aware), Prettier, `tsc --noEmit` |
| `test` | Unit + architecture tests (no database needed) |
| `test:e2e` | End-to-end tests against the real `doc_tayo_test` database |
| `docker:build` / `docker:up` / `docker:migrate` / `docker:down` | Build the image / run the API in Docker / apply migrations in Docker / stop (see [Docker guide](docs/docker.md)) |
| `db:bootstrap` | One-time idempotent setup of roles, databases and grants (needs `DB_ADMIN_URL`) |
| `db:generate` | `prisma generate` |
| `db:migrate:dev` / `db:migrate:deploy` / `db:migrate:status` | Migrations (owner role) |
| `db:test:reset` | Reset the test DB (refuses non-`_test` names; Prisma asks for confirmation) |

## Documentation

- [Docker guide](docs/docker.md) (what it is, explained at two levels, and how to run it)
- [Environment variables](docs/environment.md)
- [Database, roles and migrations](docs/database.md)
- [API conventions](docs/api-conventions.md) · [Error codes](docs/error-codes.md)
- [Architecture](docs/architecture.md) · [Security & privacy notes](docs/security-privacy.md)
- [Architecture decision records](docs/adr)

## Conventions in one minute

- ESM: relative imports end in `.js`; no `__dirname`; tests use Vitest (`vi.fn()`).
- Configuration is read only inside `src/config` (enforced by lint). Never read `process.env` elsewhere.
- Raw SQL: tagged `$queryRaw` only; the unsafe variants are forbidden (enforced by a test).
- Never log request bodies, tokens, query strings or patient data. See [security notes](docs/security-privacy.md).
