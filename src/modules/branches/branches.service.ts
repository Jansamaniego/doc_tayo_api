import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error.js';
import { pageMeta } from '../../common/dto/pagination.js';
import { RequestContext } from '../../context/request-context.js';
import { TenantPrismaService } from '../../prisma/tenant-prisma.service.js';
import { AuditService, changedFieldNames } from '../audit/audit.service.js';
import type {
  CreateBranchDto,
  ListBranchesQuery,
  UpdateBranchDto,
} from './dto/branch.dto.js';

/** Uses ONLY the tenant-scoped client; the tenant comes from the context. */
@Injectable()
export class BranchesService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListBranchesQuery) {
    const where =
      query.isActive === undefined ? {} : { isActive: query.isActive };
    const [rows, totalItems] = await Promise.all([
      this.db.branch.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.db.branch.count({ where }),
    ]);
    return { rows, meta: pageMeta(query.page, query.pageSize, totalItems) };
  }

  async get(id: string) {
    const row = await this.db.branch.findUnique({ where: { id } });
    if (!row) throw new DomainError('NOT_FOUND');
    return row;
  }

  create(dto: CreateBranchDto) {
    const tenantId = this.context.requireTenant();
    return this.db.$transaction(async (tx) => {
      const row = await tx.branch.create({
        data: {
          tenantId,
          name: dto.name,
          ...(dto.addressLine !== undefined && {
            addressLine: dto.addressLine,
          }),
          ...(dto.city !== undefined && { city: dto.city }),
          ...(dto.province !== undefined && { province: dto.province }),
          ...(dto.timezone !== undefined && { timezone: dto.timezone }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
      await this.audit.record(tx, {
        action: 'branch.created',
        entityType: 'branch',
        entityId: row.id,
        changedFields: Object.keys(dto).sort(),
      });
      return row;
    });
  }

  update(id: string, dto: UpdateBranchDto) {
    const patch = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.addressLine !== undefined && { addressLine: dto.addressLine }),
      ...(dto.city !== undefined && { city: dto.city }),
      ...(dto.province !== undefined && { province: dto.province }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.isActive !== undefined && { isActive: dto.isActive }),
    };
    return this.db.$transaction(async (tx) => {
      const current = await tx.branch.findUnique({ where: { id } });
      if (!current) throw new DomainError('NOT_FOUND');
      const changed = changedFieldNames(current, patch);
      if (changed.length === 0) return current;
      const updated = await tx.branch.update({ where: { id }, data: patch });
      await this.audit.record(tx, {
        action: 'branch.updated',
        entityType: 'branch',
        entityId: id,
        changedFields: changed,
      });
      return updated;
    });
  }
}
