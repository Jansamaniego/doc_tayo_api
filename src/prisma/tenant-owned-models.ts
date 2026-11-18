/**
 * Registry of models that carry a `tenantId`. A schema test
 * (test/architecture/tenant-registry.spec.ts) keeps this list and
 * prisma/schema/*.prisma in step: add a model with `tenantId` and the build
 * fails until it is registered here.
 */

/** Fully scoped by TenantPrismaService: every read/write is bound to the tenant. */
export const TENANT_OWNED_MODELS = [
  'Branch',
  'TenantMembership',
  'Role',
  'RolePermission',
  'MembershipRole',
] as const;

/**
 * Tenant-attributed but append-only (`tenantId` is nullable for platform
 * events): through the tenant client only `create`/`createMany` (stamped with
 * the tenant) and tenant-scoped reads exist; update/delete are refused.
 */
export const TENANT_APPEND_ONLY_MODELS = ['AuditLog'] as const;

export type TenantOwnedModel = (typeof TENANT_OWNED_MODELS)[number];
export type TenantAppendOnlyModel = (typeof TENANT_APPEND_ONLY_MODELS)[number];
