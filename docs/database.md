# Database

One PostgreSQL database, `public` schema, shared by all tenants (see `plan.md` §3). Prisma 7.10.1 (CLI, client and `@prisma/adapter-pg` are pinned to the same exact version; do not use Prisma 8 release candidates — see ADR-0001).

## Roles

| Role | Purpose | Notes |
|---|---|---|
| `postgres` (superuser) | One-time bootstrap only (`DB_ADMIN_URL`) | Never used by the app, Prisma CLI or tests. |
| `doctayo_owner` | Owns databases and the `public` schema; runs migrations | `DATABASE_MIGRATION_URL`. `CREATEDB` so `migrate dev` can make a shadow DB (production only needs `migrate deploy`). |
| `doctayo_app` | Runtime: DML only | `DATABASE_URL`. No DDL, not superuser, `NOBYPASSRLS`. Default privileges grant it access to tables the owner creates later. |

`scripts/db/bootstrap.sql` creates all of this and is idempotent (run it as an admin; on managed PostgreSQL run it once with your admin role). `npm run db:bootstrap` wraps it, taking the role passwords from `DATABASE_URL` / `DATABASE_MIGRATION_URL`. A database that already exists (for example one created by hand) is kept and handed to `doctayo_owner`. The API refuses to start in production if its role is a superuser or bypasses RLS, and warns elsewhere.

## Local setup

Requires PostgreSQL ≥ 15 on `localhost:5432`.

```bash
DB_ADMIN_URL=postgresql://postgres:<password>@localhost:5432/postgres npm run db:bootstrap
```
This creates the roles, `doc_tayo` (reused if it exists) and `doc_tayo_test`, and sets grants. It only adds roles/databases and changes ownership of those two databases; re-running is safe. The development role passwords in `.env.example` are throwaway values for a local machine — change them anywhere else.

## Prisma

- `prisma.config.ts`: schema folder `prisma/schema/` (multi-file; one file per domain from Phase 2), migrations in `prisma/migrations/`, datasource URL from `DATABASE_MIGRATION_URL`. It loads `.env` itself (Prisma 7 does not).
- Generated client: `src/generated/prisma` (gitignored; created by `npm run db:generate`, which `build`, `typecheck`, `test` and `test:e2e` run first).
- Runtime connection: `PrismaService` uses the `pg` adapter with `schema` from config. Query logging is off (parameters can hold patient data).

## Migrations

| Command | When |
|---|---|
| `npm run db:migrate:dev -- --name <name>` | Create + apply a migration locally; commit the result |
| `npm run db:migrate:deploy` | CI / production |
| `npm run db:migrate:status` | Check drift |

Never edit an applied migration. Raw SQL belongs in a migration when Prisma cannot model it (exclusion constraints, `pg_trgm`, RLS).

`20261118000000_tenancy_foundation` (Phase 2) creates `users`, `permissions`, `tenants`, `branches`, `tenant_memberships`, `roles`, `role_permissions`, `membership_roles`, `audit_logs`; inserts the permission catalog rows; and ends with `REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM doctayo_app` (append-only, tested as the runtime role).

Conventions in force: snake_case plural tables, UUIDv7 ids generated **by the client** (`@default(uuid(7))`; raw SQL inserts must supply ids), `timestamptz` timestamps with a database default, composite `(tenant_id, id)` keys for every tenant-owned table, `onDelete: Restrict` everywhere. See `docs/multitenancy.md`.

## Test database

`doc_tayo_test` is separate from development data. The e2e global setup refuses any database whose name does not end in `_test`, then runs `migrate deploy`. `npm run db:test:reset` resets it (Prisma requires confirmation because it is destructive). **After a reset, re-run `scripts/db/bootstrap.sql`**: Prisma may recreate the schema and drop the runtime role's grants (not verified; re-running is idempotent and safe).
