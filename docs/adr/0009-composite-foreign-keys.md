# ADR-0009: Composite foreign keys for tenant-owned relations

Status: accepted (Phase 2)

## Decision

Every tenant-owned table has `tenant_id` and `UNIQUE (tenant_id, id)`. Any relation between two tenant-owned tables is a composite foreign key `(tenant_id, x_id) -> (tenant_id, id)`. Relations to global tables (`users`, `permissions`) are plain keys. `onDelete: Restrict` everywhere.

A row in tenant A therefore cannot reference a row in tenant B even if application code is wrong. `test/tenancy-schema.e2e-spec.ts` proves it with raw inserts, and `test/architecture/tenant-registry.spec.ts` fails the build when a model or relation breaks the convention.

## Verified in the M1 spike (Prisma 7.10.1)

- Two composite relations sharing `tenant_id` on one model (`membership_roles`) generate the expected SQL.
- Nested `connect` works; a cross-tenant `connect` or scalar create is rejected by the database (`P2003` -> `CONFLICT_REFERENCE`). Scalar FK columns are preferred, nested writes are allowed.
- Extra non-unique fields in a unique `where` (`{ id, tenantId }`) work, which is how the tenant extension scopes `findUnique`/`update`/`delete`.
- `Prisma.dmmf` is not available in the generated client, so the registry test parses `prisma/schema/*.prisma`.
- `audit_logs.tenant_id` is nullable (platform events), so it is "tenant-attributed append-only", not tenant-owned: through the tenant client only `create` (stamped) and scoped reads exist.
- `role_permissions` and `membership_roles` keep their composite primary keys and also carry a non-PK `id` so the `UNIQUE (tenant_id, id)` rule has no exceptions.
- ids are client-generated UUIDv7 (`@default(uuid(7))`); there is no database default.
