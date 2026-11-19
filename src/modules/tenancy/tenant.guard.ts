import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { TENANT_NOT_REQUIRED_KEY } from '../../common/decorators/tenant-not-required.decorator.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { RequestContext } from '../../context/request-context.js';
import { MembershipResolver } from './membership-resolver.js';
import { tenantAccessError } from './tenant-access.js';

/**
 * Turns the tenant the credential asks for into a VERIFIED tenant: the user
 * must be an active member of an active tenant. Only then is `tenantId` placed
 * in the request context (the only place domain code reads it from).
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
    private readonly resolver: MembershipResolver,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const targets = [execution.getHandler(), execution.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(
        IS_PUBLIC_KEY,
        targets,
      ) ||
      this.reflector.getAllAndOverride<boolean | undefined>(
        TENANT_NOT_REQUIRED_KEY,
        targets,
      )
    ) {
      return true;
    }

    const tenantId = this.context.activeTenantId;
    if (!tenantId) throw new DomainError('TENANT_NOT_SELECTED');
    const userId = this.context.requireUser();

    const membership = await this.resolver.resolve(tenantId, userId);
    const denial = tenantAccessError(membership);
    if (denial === 'TENANT_ACCESS_DENIED') {
      // Security event: ids only, never request data.
      this.logger.warn({
        message: 'tenant access denied',
        requestId: this.context.requestId,
        userId,
        tenantId,
      });
    }
    if (denial || !membership)
      throw new DomainError(denial ?? 'TENANT_ACCESS_DENIED');

    this.context.set({
      tenantId,
      membershipId: membership.membershipId,
      permissions: new Set(membership.permissions),
    });
    return true;
  }
}
