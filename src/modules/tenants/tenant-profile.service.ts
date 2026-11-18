import { Injectable } from '@nestjs/common';
import { RequestContext } from '../../context/request-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService, changedFieldNames } from '../audit/audit.service.js';
import type { UpdateTenantDto } from './dto/tenant.dto.js';

/** Profile of the ACTIVE tenant only: the id always comes from the context. */
@Injectable()
export class TenantProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: RequestContext,
    private readonly audit: AuditService,
  ) {}

  get() {
    return this.prisma.tenant.findUniqueOrThrow({
      where: { id: this.context.requireTenant() },
    });
  }

  async update(dto: UpdateTenantDto) {
    const id = this.context.requireTenant();
    const patch = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      ...(dto.contactEmail !== undefined && { contactEmail: dto.contactEmail }),
      ...(dto.contactPhone !== undefined && { contactPhone: dto.contactPhone }),
    };
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.tenant.findUniqueOrThrow({ where: { id } });
      const changed = changedFieldNames(current, patch);
      if (changed.length === 0) return current;
      const updated = await tx.tenant.update({ where: { id }, data: patch });
      await this.audit.record(tx, {
        action: 'tenant.updated',
        entityType: 'tenant',
        entityId: id,
        changedFields: changed,
      });
      return updated;
    });
  }
}
