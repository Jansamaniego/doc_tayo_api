import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RequestContext } from '../../context/request-context.js';
import { AUTHENTICATOR, type Authenticator } from '../auth/authenticator.js';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { DomainError } from '../errors/domain-error.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
    private readonly context: RequestContext,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [execution.getHandler(), execution.getClass()],
    );
    if (isPublic) return true;

    const request = execution.switchToHttp().getRequest<Request>();
    const principal = await this.authenticator.authenticate(request);
    if (!principal) throw new DomainError('UNAUTHENTICATED');

    this.context.set({
      userId: principal.userId,
      sessionId: principal.sessionId,
      activeTenantId: principal.activeTenantId,
    });
    return true;
  }
}
