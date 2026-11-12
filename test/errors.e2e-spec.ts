import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { vi } from 'vitest';

describe('Error handling (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  function expectShape(body: any, status: number, code: string) {
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({ status, code });
    expect(typeof body.error.message).toBe('string');
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  }

  it('unknown route -> ROUTE_NOT_FOUND', async () => {
    const res = await http().get('/api/nothing-here').expect(404);
    expectShape(res.body, 404, 'ROUTE_NOT_FOUND');
  });

  it('malformed JSON -> MALFORMED_JSON with a request id', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .set('Content-Type', 'application/json')
      .send('{"email": ')
      .expect(400);
    expectShape(res.body, 400, 'MALFORMED_JSON');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('oversized body -> PAYLOAD_TOO_LARGE', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(2 * 1024 * 1024) }))
      .expect(413);
    expectShape(res.body, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('unsupported charset -> UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send('{}')
      .expect(415);
    expectShape(res.body, 415, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('DomainError uses its catalog entry', async () => {
    const res = await http().get('/api/v1/_test/domain-error').expect(409);
    expectShape(res.body, 409, 'CONFLICT');
  });

  it('maps Prisma errors without exposing meta or text', async () => {
    const unique = await http().get('/api/v1/_test/prisma-unique').expect(409);
    expectShape(unique.body, 409, 'CONFLICT_UNIQUE');
    const missing = await http()
      .get('/api/v1/_test/prisma-missing')
      .expect(404);
    expectShape(missing.body, 404, 'NOT_FOUND');
    const other = await http().get('/api/v1/_test/prisma-other').expect(500);
    expectShape(other.body, 500, 'INTERNAL_ERROR');
    for (const res of [unique, missing, other]) {
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(
        /users_email_key|pg_catalog|SELECT|target|meta/i,
      );
    }
  });

  it('does not leak internals for unexpected exceptions', async () => {
    const res = await http().get('/api/v1/_test/unexpected').expect(500);
    expectShape(res.body, 500, 'INTERNAL_ERROR');
    const text = JSON.stringify(res.body);
    for (const leak of [
      'stack',
      'SELECT',
      'postgres://',
      'TOKEN-LEAK',
      'secret-sql',
      'node_modules',
      'prisma',
      'at ',
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it('readiness failure answers NOT_READY with no infrastructure details', async () => {
    const prisma = app.get(PrismaService);
    const spy = vi
      .spyOn(prisma, '$queryRaw')
      .mockRejectedValue(
        new Error(
          'connect ECONNREFUSED db-host.internal:5432 password=hunter2',
        ),
      );
    try {
      const res = await http().get('/api/health/ready').expect(503);
      expectShape(res.body, 503, 'NOT_READY');
      expect(JSON.stringify(res.body)).not.toMatch(
        /ECONNREFUSED|db-host|hunter2|5432/,
      );
      await http().get('/api/health').expect(200); // liveness unaffected
    } finally {
      spy.mockRestore();
    }
    await http().get('/api/health/ready').expect(200);
  });
});
