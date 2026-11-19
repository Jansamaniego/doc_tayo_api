import {
  Global,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { PermissionsGuard } from '../../common/guards/permissions.guard.js';
import { requestContextMiddleware } from '../../context/request-context.middleware.js';
import { RequestContext } from '../../context/request-context.js';
import { AuthModule } from '../auth/auth.module.js';
import { throttlerOptions } from '../auth/throttle.js';
import {
  MembershipResolver,
  PrismaMembershipResolver,
} from './membership-resolver.js';
import { TenantGuard } from './tenant.guard.js';
import { UserMembershipsService } from './user-memberships.service.js';

/**
 * Request context + the global guard chain. APP_GUARD providers run in the
 * order they are declared: AuthGuard -> TenantGuard -> PermissionsGuard
 * ThrottlerGuard runs first, so rate limits apply before authentication.
 */
@Global()
@Module({
  // AuthModule provides the AUTHENTICATOR binding (JwtAuthenticator).
  imports: [AuthModule, ThrottlerModule.forRoot(throttlerOptions)],
  providers: [
    RequestContext,
    { provide: MembershipResolver, useClass: PrismaMembershipResolver },
    UserMembershipsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  // ThrottlerModule is re-exported so route-level guards (UserThrottleGuard)
  // share the one in-memory counter store with the global ThrottlerGuard.
  exports: [
    RequestContext,
    MembershipResolver,
    UserMembershipsService,
    ThrottlerModule,
  ],
})
export class TenancyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(requestContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
