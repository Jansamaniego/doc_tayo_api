import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AUTHENTICATOR } from '../../common/auth/authenticator.js';
import { DenyAllAuthenticator } from '../../common/auth/deny-all.authenticator.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { requestContextMiddleware } from '../../context/request-context.middleware.js';
import { RequestContext } from '../../context/request-context.js';
import {
  MembershipResolver,
  PrismaMembershipResolver,
} from './membership-resolver.js';
import { TenantGuard } from './tenant.guard.js';

/**
 * Request context + the global guard chain. APP_GUARD providers run in the
 * order they are declared: AuthGuard -> TenantGuard -> PermissionsGuard
 * (Phase 3 inserts the throttler first).
 */
@Global()
@Module({
  providers: [
    RequestContext,
    { provide: AUTHENTICATOR, useClass: DenyAllAuthenticator },
    { provide: MembershipResolver, useClass: PrismaMembershipResolver },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [RequestContext],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(requestContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
