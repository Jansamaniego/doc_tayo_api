import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';

describe('API prefix, versioning and validation (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());
  const validBody = {
    email: 'a@example.com',
    quantity: 2,
    address: { city: 'Manila' },
  };

  it('serves business routes at /api/v1/...', async () => {
    await http().post('/api/v1/_test/items').send(validBody).expect(201);
  });

  it.each([
    '/_test/items',
    '/v1/_test/items',
    '/api/_test/items',
    '/api/api/v1/_test/items',
    '/api/v1/v1/_test/items',
    '/api/v2/_test/items',
  ])('does not serve %s', async (path) => {
    const res = await http().post(path).send(validBody).expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  it('serves health at /api/health only (version-neutral, not /api/v1/health)', async () => {
    await http().get('/api/health').expect(200);
    await http().get('/api/v1/health').expect(404);
    await http().get('/health').expect(404);
  });

  it('rejects invalid fields with field-level details', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .send({ email: 'nope', quantity: 0, address: { city: 'x'.repeat(50) } })
      .expect(400);
    expect(res.body.error).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email', code: 'INVALID_FORMAT' }),
        expect.objectContaining({ field: 'quantity', code: 'OUT_OF_RANGE' }),
        expect.objectContaining({ field: 'address.city', code: 'TOO_LONG' }),
      ]),
    );
  });

  it('rejects missing fields and wrong types without coercion', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .send({
        email: 'a@example.com',
        quantity: '2',
        address: { city: 'Manila' },
      })
      .expect(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'quantity', code: 'INVALID_TYPE' }),
      ]),
    );
  });

  it('rejects unknown properties', async () => {
    const res = await http()
      .post('/api/v1/_test/items')
      .send({ ...validBody, tenantId: 'other-tenant', role: 'admin' })
      .expect(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'tenantId', code: 'UNKNOWN_FIELD' }),
        expect.objectContaining({ field: 'role', code: 'UNKNOWN_FIELD' }),
      ]),
    );
  });
});
