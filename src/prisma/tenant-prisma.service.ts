import { Injectable } from '@nestjs/common';
import { RequestContext } from '../context/request-context.js';
import { PrismaService } from './prisma.service.js';
import {
  TENANT_APPEND_ONLY_MODELS,
  TENANT_OWNED_MODELS,
} from './tenant-owned-models.js';

const owned = new Set<string>(TENANT_OWNED_MODELS);
const appendOnly = new Set<string>(TENANT_APPEND_ONLY_MODELS);

/** Operations whose `where` is a filter: AND the tenant onto it. */
const FILTER_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'updateManyAndReturn',
  'deleteMany',
]);
/** Operations whose `where` is a unique selector: add `tenantId` to it. */
const UNIQUE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'delete',
  'upsert',
]);
const CREATE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
]);
const UPDATE_OPERATIONS = new Set([
  'update',
  'updateMany',
  'updateManyAndReturn',
]);
const APPEND_ONLY_ALLOWED = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

type Args = Record<string, unknown>;

function stampRow(row: unknown, tenantId: string): Record<string, unknown> {
  const data = { ...(row as Record<string, unknown>) };
  if ('tenant' in data) {
    throw new Error(
      'Do not set the tenant relation: the tenant comes from the request context.',
    );
  }
  if ('tenantId' in data && data['tenantId'] !== tenantId) {
    throw new Error(
      'tenantId does not match the tenant in the request context.',
    );
  }
  data['tenantId'] = tenantId;
  return data;
}

function assertNoTenantChange(data: unknown): void {
  if (data && typeof data === 'object') {
    if ('tenantId' in data || 'tenant' in data) {
      throw new Error('The tenant of a row can never be changed.');
    }
  }
}

function scope(
  operation: string,
  args: Args | undefined,
  tenantId: string,
): Args {
  const next: Args = { ...args };

  if (FILTER_OPERATIONS.has(operation)) {
    next['where'] = { AND: [next['where'] ?? {}, { tenantId }] };
  } else if (UNIQUE_OPERATIONS.has(operation)) {
    next['where'] = { ...((next['where'] ?? {}) as object), tenantId };
  }

  if (CREATE_OPERATIONS.has(operation)) {
    const data = next['data'];
    next['data'] = Array.isArray(data)
      ? data.map((row) => stampRow(row, tenantId))
      : stampRow(data, tenantId);
  }
  if (operation === 'upsert') {
    next['create'] = stampRow(next['create'], tenantId);
  }
  if (UPDATE_OPERATIONS.has(operation)) assertNoTenantChange(next['data']);
  if (operation === 'upsert') assertNoTenantChange(next['update']);

  return next;
}

/**
 * Tenant-scoped Prisma access (a client extension over PrismaService). Every
 * query on a registered model is bound to the tenant in RequestContext; with no
 * tenant in context the query throws. Only tenant-owned model delegates and an
 * interactive `$transaction` are exposed: no raw SQL, no global models.
 */
function createTenantClient(prisma: PrismaService, context: RequestContext) {
  return prisma.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          const isOwned = owned.has(model);
          const isAppendOnly = appendOnly.has(model);
          if (!isOwned && !isAppendOnly) {
            // Not reachable through TenantPrismaService; fail closed anyway.
            throw new Error(
              'Model is not available through the tenant client.',
            );
          }
          const tenantId = context.requireTenant();
          if (isAppendOnly && !APPEND_ONLY_ALLOWED.has(operation)) {
            throw new Error('This model is append-only.');
          }
          const known =
            FILTER_OPERATIONS.has(operation) ||
            UNIQUE_OPERATIONS.has(operation) ||
            CREATE_OPERATIONS.has(operation);
          if (!known)
            throw new Error('Operation is not supported by the tenant client.');
          return query(scope(operation, args as Args, tenantId) as typeof args);
        },
      },
    },
  });
}

type TenantClient = ReturnType<typeof createTenantClient>;

/** The delegates a domain module may use. */
export interface TenantModels {
  readonly branch: TenantClient['branch'];
  readonly tenantMembership: TenantClient['tenantMembership'];
  readonly role: TenantClient['role'];
  readonly rolePermission: TenantClient['rolePermission'];
  readonly membershipRole: TenantClient['membershipRole'];
  readonly auditLog: TenantClient['auditLog'];
}

const pickModels = (client: TenantClient): TenantModels => ({
  branch: client.branch,
  tenantMembership: client.tenantMembership,
  role: client.role,
  rolePermission: client.rolePermission,
  membershipRole: client.membershipRole,
  auditLog: client.auditLog,
});

@Injectable()
export class TenantPrismaService implements TenantModels {
  readonly branch: TenantClient['branch'];
  readonly tenantMembership: TenantClient['tenantMembership'];
  readonly role: TenantClient['role'];
  readonly rolePermission: TenantClient['rolePermission'];
  readonly membershipRole: TenantClient['membershipRole'];
  readonly auditLog: TenantClient['auditLog'];

  private readonly client: TenantClient;

  constructor(prisma: PrismaService, context: RequestContext) {
    this.client = createTenantClient(prisma, context);
    const models = pickModels(this.client);
    this.branch = models.branch;
    this.tenantMembership = models.tenantMembership;
    this.role = models.role;
    this.rolePermission = models.rolePermission;
    this.membershipRole = models.membershipRole;
    this.auditLog = models.auditLog;
  }

  /** Interactive transaction; the callback receives scoped delegates only. */
  $transaction<T>(
    fn: (tx: TenantModels) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T> {
    return this.client.$transaction(
      (tx) => fn(pickModels(tx as TenantClient)),
      options,
    );
  }
}
