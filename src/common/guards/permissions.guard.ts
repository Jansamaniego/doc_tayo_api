import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequestContext } from '../../context/request-context.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator.js';
import { TENANT_NOT_REQUIRED_KEY } from '../decorators/tenant-not-required.decorator.js';
import { DomainError } from '../errors/domain-error.js';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly context: RequestContext,
  ) {}

  canActivate(execution: ExecutionContext): boolean {
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

    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      targets,
    );
    // Deny by default: a tenant-scoped route must declare its permissions.
    if (!required || required.length === 0) throw new DomainError('FORBIDDEN');

    const held = this.context.permissions;
    if (!required.every((permission) => held.has(permission))) {
      throw new DomainError('FORBIDDEN');
    }
    return true;
  }
}
