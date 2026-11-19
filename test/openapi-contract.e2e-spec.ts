import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { buildOpenApiDocument } from '../src/app.setup.js';
import {
  ERROR_CODES,
  FIELD_ERROR_CODES,
} from '../src/common/errors/error-codes.js';
import { createTestApp } from './setup/create-test-app.js';
import {
  createActiveUser,
  seedMembership,
  TEST_PASSWORD,
} from './support/auth.js';
import { createOwnerClient, resetTenancyData } from './support/db.js';
import { ResettableThrottlerStorage } from './support/resettable-throttler-storage.js';

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  type?: string;
  enum?: string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: unknown;
  items?: Schema;
};
interface Operation {
  security?: Record<string, string[]>[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
interface Doc {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes?: Record<string, Record<string, string>>;
  };
}

describe('OpenAPI is a complete, truthful contract for the frontend (real PostgreSQL)', () => {
  let app: NestExpressApplication;
  let owner: PrismaClient;
  let throttle: ResettableThrottlerStorage;
  let doc: Doc;

  beforeAll(async () => {
    owner = createOwnerClient();
    app = await createTestApp({
      productionAuthenticator: true,
      env: { SWAGGER_ENABLED: 'true' },
    });
    throttle = app.get(ThrottlerStorage) as ResettableThrottlerStorage;
    doc = (await request(app.getHttpServer()).get('/api/docs-json').expect(200))
      .body as Doc;
  });
  afterAll(async () => {
    await app.close();
    await owner.$disconnect();
  });
  beforeEach(async () => {
    throttle.reset();
    await resetTenancyData(owner);
  });

  const resolve = (schema: Schema | undefined): Schema => {
    if (!schema) throw new Error('missing schema');
    // A named enum is emitted as a single-item allOf around its $ref.
    if (schema.allOf?.length === 1) return resolve(schema.allOf[0]);
    if (schema.$ref)
      return resolve(doc.components.schemas[schema.$ref.split('/').pop()!]);
    return schema;
  };
  /** The documented `data` schema of an operation's success response. */
  const dataSchema = (path: string, method: string, status: string): Schema => {
    const response = doc.paths[path]?.[method]?.responses?.[status];
    const body = resolve(response?.content?.['application/json']?.schema);
    return resolve(body.properties?.data);
  };
  const keys = (schema: Schema): string[] =>
    Object.keys(resolve(schema).properties ?? {}).sort();

  it('every operation that answers with a body documents its response schema', () => {
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      if (path.includes('/_test') || path.includes('/_tenant')) continue; // test-only controllers
      for (const [method, op] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(op.responses ?? {})) {
          if (!status.startsWith('2') || status === '204') continue;
          if (!response.content?.['application/json']?.schema)
            missing.push(`${method.toUpperCase()} ${path} -> ${status}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every operation that takes a body documents its request schema', () => {
    const missing: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      if (path.includes('/_test') || path.includes('/_tenant')) continue;
      for (const [method, op] of Object.entries(methods)) {
        const hasBodySchema =
          !!op.requestBody?.content?.['application/json']?.schema;
        if (
          ['post', 'patch', 'put'].includes(method) &&
          op.requestBody &&
          !hasBodySchema
        ) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  describe('errors, security and generated types', () => {
    const operations = () =>
      Object.entries(doc.paths).flatMap(([path, methods]) =>
        path.includes('/_test') || path.includes('/_tenant')
          ? []
          : Object.entries(methods).map(([method, op]) => ({
              label: `${method.toUpperCase()} ${path}`,
              path,
              method,
              op,
            })),
      );

    it('documents the error body once, with the codes the API really uses', () => {
      const error = resolve(doc.components.schemas.ErrorResponse).properties
        ?.error;
      const body = resolve(error);
      expect(Object.keys(body.properties ?? {}).sort()).toEqual([
        'code',
        'details',
        'message',
        'requestId',
        'status',
      ]);
      expect(body.required?.sort()).toEqual([
        'code',
        'message',
        'requestId',
        'status',
      ]);
      expect(resolve(body.properties?.code).enum).toEqual(
        Object.keys(ERROR_CODES),
      );
      const detail = resolve(body.properties?.details?.items);
      expect(Object.keys(detail.properties ?? {}).sort()).toEqual([
        'code',
        'field',
        'message',
      ]);
      expect(resolve(detail.properties?.code).enum).toEqual(
        Object.keys(FIELD_ERROR_CODES),
      );
    });

    it('every documented 4xx/5xx response carries that error schema', () => {
      const missing = operations().flatMap(({ label, op }) =>
        Object.entries(op.responses ?? {})
          .filter(([status]) => /^[45]/.test(status))
          .filter(
            ([, r]) =>
              r.content?.['application/json']?.schema?.$ref !==
              '#/components/schemas/ErrorResponse',
          )
          .map(([status]) => `${label} -> ${status}`),
      );
      expect(missing).toEqual([]);
    });

    it('the documented error body equals a real error response', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/me')
        .expect(401);
      expect(Object.keys(res.body)).toEqual(['error']);
      const body = resolve(
        resolve(doc.components.schemas.ErrorResponse).properties?.error,
      );
      const documented = Object.keys(body.properties ?? {});
      expect(
        Object.keys(res.body.error).every((k) => documented.includes(k)),
      ).toBe(true);
      for (const required of body.required ?? [])
        expect(res.body.error).toHaveProperty(required);
    });

    it('declares the bearer scheme: protected operations require it, public ones do not', () => {
      expect(doc.components.securitySchemes?.bearer).toMatchObject({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      });
      const find = (method: string, path: string) =>
        operations().find((o) => o.method === method && o.path === path)!.op;
      const publicOps: [string, string][] = [
        ['post', '/api/v1/auth/login'],
        ['post', '/api/v1/auth/refresh'],
        ['post', '/api/v1/auth/password/forgot'],
        ['post', '/api/v1/auth/password/reset'],
        ['post', '/api/v1/auth/account/setup'],
        ['post', '/api/v1/invitations/accept'],
        ['get', '/api/health'],
        ['get', '/api/health/ready'],
      ];
      for (const [method, path] of publicOps)
        expect(find(method, path).security, `${method} ${path}`).toEqual([]);
      const protectedOps: [string, string][] = [
        ['get', '/api/v1/me'],
        ['post', '/api/v1/auth/logout'],
        ['post', '/api/v1/auth/switch-tenant'],
        ['get', '/api/v1/tenant'],
        ['get', '/api/v1/branches'],
        ['post', '/api/v1/invitations'],
      ];
      for (const [method, path] of protectedOps)
        expect(find(method, path).security, `${method} ${path}`).toEqual([
          { bearer: [] },
        ]);
    });

    it('no property is typed as a bare `object` (a generated client would get `object` instead of the real type)', () => {
      const bare = Object.entries(doc.components.schemas).flatMap(
        ([name, schema]) =>
          Object.entries(schema.properties ?? {})
            .filter(
              ([, p]) =>
                p.type === 'object' &&
                !p.properties &&
                p.additionalProperties === undefined,
            )
            .map(([prop]) => `${name}.${prop}`),
      );
      expect(bare).toEqual([]);
    });

    it('memberships carry role keys as well as display names', () => {
      const membership = resolve(doc.components.schemas.MembershipResponse);
      const role = resolve(membership.properties?.roles?.items);
      expect(Object.keys(role.properties ?? {}).sort()).toEqual([
        'key',
        'name',
      ]);
    });
  });

  it('docs/openapi.json is the committed, current contract (run `npm run openapi:export` after changing the API)', async () => {
    // A clean app: only the real modules, no test-only controllers.
    const clean = await createTestApp({
      omitTestControllers: true,
      env: { SWAGGER_ENABLED: 'true' },
    });
    try {
      const generated = JSON.parse(
        JSON.stringify(buildOpenApiDocument(clean)),
      ) as unknown;
      const committed = JSON.parse(
        readFileSync('docs/openapi.json', 'utf8'),
      ) as unknown;
      expect(generated).toEqual(committed);
    } finally {
      await clean.close();
    }
  });

  describe('documented shapes equal the real responses', () => {
    it('login, refresh and switch-tenant', async () => {
      const user = await createActiveUser(owner, 'doc@example.com');
      const a = await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      await seedMembership(owner, user.id, 'clinic-b', ['receptionist']);
      const http = () => request(app.getHttpServer());

      const login = await http()
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const loginSchema = dataSchema('/api/v1/auth/login', 'post', '200');
      expect(keys(loginSchema)).toEqual(Object.keys(login.body.data).sort());
      expect(keys(resolve(loginSchema.properties!.user))).toEqual(
        Object.keys(login.body.data.user).sort(),
      );
      expect(keys(resolve(loginSchema.properties!.memberships!.items))).toEqual(
        Object.keys(login.body.data.memberships[0]).sort(),
      );

      const cookie = (login.headers['set-cookie'] as unknown as string[])
        .find((c) => c.startsWith('dt_refresh='))!
        .split(';')[0]!;
      const refreshed = await http()
        .post('/api/v1/auth/refresh')
        .set('Origin', 'http://localhost:5173')
        .set('Cookie', cookie)
        .expect(200);
      expect(keys(dataSchema('/api/v1/auth/refresh', 'post', '200'))).toEqual(
        Object.keys(refreshed.body.data).sort(),
      );

      const switched = await http()
        .post('/api/v1/auth/switch-tenant')
        .set('Authorization', `Bearer ${refreshed.body.data.accessToken}`)
        .send({ tenantId: a.tenantId })
        .expect(200);
      const switchSchema = dataSchema(
        '/api/v1/auth/switch-tenant',
        'post',
        '200',
      );
      expect(keys(switchSchema)).toEqual(
        Object.keys(switched.body.data).sort(),
      );
      expect(keys(resolve(switchSchema.properties!.tenant))).toEqual(
        Object.keys(switched.body.data.tenant).sort(),
      );

      const forgot = await http()
        .post('/api/v1/auth/password/forgot')
        .send({ email: user.email })
        .expect(202);
      expect(
        keys(dataSchema('/api/v1/auth/password/forgot', 'post', '202')),
      ).toEqual(Object.keys(forgot.body.data).sort());
    });

    it('/me, /me/memberships and /me/sessions', async () => {
      const user = await createActiveUser(owner, 'doc@example.com');
      await seedMembership(owner, user.id, 'clinic-a', ['owner']);
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: user.email, password: TEST_PASSWORD })
        .expect(200);
      const auth = {
        Authorization: `Bearer ${login.body.data.accessToken as string}`,
      };
      const get = (path: string) =>
        request(app.getHttpServer()).get(path).set(auth).expect(200);

      const me = await get('/api/v1/me');
      expect(keys(dataSchema('/api/v1/me', 'get', '200'))).toEqual(
        Object.keys(me.body.data).sort(),
      );

      const memberships = await get('/api/v1/me/memberships');
      const membershipsSchema = dataSchema(
        '/api/v1/me/memberships',
        'get',
        '200',
      );
      expect(membershipsSchema.type).toBe('array');
      expect(keys(resolve(membershipsSchema.items))).toEqual(
        Object.keys(memberships.body.data[0]).sort(),
      );
      expect(
        keys(
          resolve(resolve(membershipsSchema.items).properties?.roles?.items),
        ),
      ).toEqual(Object.keys(memberships.body.data[0].roles[0]).sort());

      const sessions = await get('/api/v1/me/sessions');
      const sessionsSchema = dataSchema('/api/v1/me/sessions', 'get', '200');
      expect(sessionsSchema.type).toBe('array');
      expect(keys(resolve(sessionsSchema.items))).toEqual(
        Object.keys(sessions.body.data[0]).sort(),
      );
    });
  });
});
