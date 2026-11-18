import { Body, Controller, Get, Post } from '@nestjs/common';
import { Public } from '../../src/common/decorators/public.decorator.js';
import { RequirePermissions } from '../../src/common/decorators/require-permissions.decorator.js';
import { TenantNotRequired } from '../../src/common/decorators/tenant-not-required.decorator.js';
import { RequestContext } from '../../src/context/request-context.js';
import { PERMISSIONS } from '../../src/modules/access-control/catalog.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Test-only routes, one per route category (registered by createTestApp). */
@Controller({ path: '_tenant', version: '1' })
export class TenantTestController {
  constructor(private readonly context: RequestContext) {}

  @Public()
  @Get('public')
  open() {
    return { data: { ok: true } };
  }

  @TenantNotRequired()
  @Get('no-tenant')
  noTenant() {
    return { data: { userId: this.context.requireUser() } };
  }

  @RequirePermissions(PERMISSIONS.TENANT_READ)
  @Get('read')
  read() {
    return { data: { ok: true } };
  }

  @RequirePermissions(PERMISSIONS.BRANCHES_MANAGE)
  @Get('manage')
  manage() {
    return { data: { ok: true } };
  }

  /** Tenant-scoped but declares no permission: must be denied by default. */
  @Get('undecorated')
  undecorated() {
    return { data: { ok: true } };
  }

  /** Reads the context before and after an await, to detect context bleed. */
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  @Get('context')
  async contextProbe() {
    const before = this.context.requireTenant();
    await sleep(Math.floor(Math.random() * 15));
    const after = this.context.requireTenant();
    return {
      data: {
        before,
        after,
        userId: this.context.requireUser(),
        membershipId: this.context.membershipId,
        requestId: this.context.requestId,
        permissions: [...this.context.permissions].sort(),
      },
    };
  }

  /** The tenant must still be known after the request body was parsed. */
  @RequirePermissions(PERMISSIONS.TENANT_READ)
  @Post('echo')
  async echo(@Body() body: Record<string, unknown>) {
    await sleep(Math.floor(Math.random() * 10));
    return {
      data: {
        tenantId: this.context.requireTenant(),
        size: Object.keys(body).length,
      },
    };
  }
}
