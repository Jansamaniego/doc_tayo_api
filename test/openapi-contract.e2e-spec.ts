import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ThrottlerStorage } from '@nestjs/throttler';
import request from 'supertest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { buildOpenApiDocument } from '../src/app.setup.js';
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
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};
interface Operation {
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
interface Doc {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
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

      const sessions = await get('/api/v1/me/sessions');
      const sessionsSchema = dataSchema('/api/v1/me/sessions', 'get', '200');
      expect(sessionsSchema.type).toBe('array');
      expect(keys(resolve(sessionsSchema.items))).toEqual(
        Object.keys(sessions.body.data[0]).sort(),
      );
    });
  });
});
