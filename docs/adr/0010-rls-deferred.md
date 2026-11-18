# ADR-0010: PostgreSQL row-level security deferred

Status: accepted (Phase 2)

## Decision

RLS is not enabled in Phase 2. Isolation rests on the guard chain, the tenant-scoped Prisma client, composite foreign keys, and tests. The design stays RLS-ready: every tenant-owned table has `tenant_id`, the runtime role (`doctayo_app`) is separate from the owner role and is `NOBYPASSRLS`, and the app refuses to start in production with a superuser or RLS-bypassing role.

## Why

RLS needs a per-request session setting (`SET LOCAL app.tenant_id`) inside every transaction, which interacts with connection pooling and Prisma's adapter; doing it well deserves its own spike on the most sensitive tables (Phase 7, or earlier if Q2 says so). The first three layers already make cross-tenant access fail closed, and the fourth (tests) keeps them honest.

## Revisit when

Q2 is answered with a compliance requirement for database-level enforcement, or the Phase 7 spike shows acceptable complexity.
