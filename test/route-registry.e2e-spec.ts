import { DiscoveryService, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IS_PUBLIC_KEY } from '../src/common/decorators/public.decorator.js';
import { PERMISSIONS_KEY } from '../src/common/decorators/require-permissions.decorator.js';
import { TENANT_NOT_REQUIRED_KEY } from '../src/common/decorators/tenant-not-required.decorator.js';
import { createTestApp } from './setup/create-test-app.js';

interface RouteInfo {
  route: string;
  isPublic: boolean;
  tenantNotRequired: boolean;
  permissions: string[];
}

/** Every route must be exactly one category (master plan §3.3). */
export function routeProblems(routes: RouteInfo[]): string[] {
  const problems: string[] = [];
  for (const r of routes) {
    if (r.isPublic && r.tenantNotRequired) {
      problems.push(`${r.route}: both @Public and @TenantNotRequired`);
    } else if (r.isPublic && r.permissions.length > 0) {
      problems.push(`${r.route}: @Public with @RequirePermissions`);
    } else if (r.tenantNotRequired && r.permissions.length > 0) {
      problems.push(`${r.route}: @TenantNotRequired with @RequirePermissions`);
    } else if (
      !r.isPublic &&
      !r.tenantNotRequired &&
      r.permissions.length === 0
    ) {
      problems.push(`${r.route}: tenant-scoped without @RequirePermissions`);
    }
  }
  return problems;
}

const TEST_ONLY_CONTROLLERS = new Set([
  'TestController',
  'TenantTestController',
]);
const HTTP_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'ALL',
  'OPTIONS',
  'HEAD',
];

describe('route registry (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  function discoverRoutes(): RouteInfo[] {
    const reflector = app.get(Reflector);
    const routes: RouteInfo[] = [];
    for (const wrapper of app.get(DiscoveryService).getControllers()) {
      const { metatype, instance } = wrapper;
      if (!metatype || !instance || TEST_ONLY_CONTROLLERS.has(metatype.name))
        continue;
      const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue; // carries the controller's own path metadata
        const handler = proto[name];
        if (
          typeof handler !== 'function' ||
          Reflect.getMetadata('path', handler) === undefined
        )
          continue;
        const method =
          HTTP_METHODS[Reflect.getMetadata('method', handler) as number] ?? '?';
        const targets = [handler, metatype];
        routes.push({
          route: `${method} ${String(Reflect.getMetadata('path', metatype))}/${String(Reflect.getMetadata('path', handler))} (${metatype.name}.${name})`,
          isPublic: !!reflector.getAllAndOverride(IS_PUBLIC_KEY, targets),
          tenantNotRequired: !!reflector.getAllAndOverride(
            TENANT_NOT_REQUIRED_KEY,
            targets,
          ),
          permissions:
            reflector.getAllAndOverride<string[] | undefined>(
              PERMISSIONS_KEY,
              targets,
            ) ?? [],
        });
      }
    }
    return routes;
  }

  it('discovers the real routes (the check is not vacuous)', () => {
    const names = discoverRoutes()
      .map((r) => r.route)
      .join('\n');
    for (const controller of [
      'HealthController',
      'TenantController',
      'BranchesController',
    ]) {
      expect(names).toContain(controller);
    }
    expect(discoverRoutes().length).toBeGreaterThanOrEqual(8);
  });

  it('every route is exactly one of: public, tenant-not-required, or tenant-scoped with permissions', () => {
    expect(routeProblems(discoverRoutes())).toEqual([]);
  });

  describe('self-test', () => {
    const ok = {
      isPublic: false,
      tenantNotRequired: false,
      permissions: ['tenant.read'],
    };
    it('flags an undecorated tenant route', () => {
      expect(
        routeProblems([
          {
            route: 'GET /x',
            isPublic: false,
            tenantNotRequired: false,
            permissions: [],
          },
        ]),
      ).toHaveLength(1);
    });
    it('flags contradictory decorators', () => {
      expect(
        routeProblems([{ route: 'a', ...ok, isPublic: true }]),
      ).toHaveLength(1);
      expect(
        routeProblems([{ route: 'b', ...ok, tenantNotRequired: true }]),
      ).toHaveLength(1);
      expect(
        routeProblems([
          {
            route: 'c',
            isPublic: true,
            tenantNotRequired: true,
            permissions: [],
          },
        ]),
      ).toHaveLength(1);
    });
    it('accepts valid routes', () => {
      expect(
        routeProblems([
          {
            route: 'public',
            isPublic: true,
            tenantNotRequired: false,
            permissions: [],
          },
          {
            route: 'me',
            isPublic: false,
            tenantNotRequired: true,
            permissions: [],
          },
          { route: 'scoped', ...ok },
        ]),
      ).toEqual([]);
    });
  });
});
