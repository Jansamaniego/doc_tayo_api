import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';
import type { NestExpressApplication } from '@nestjs/platform-express';

describe('Health (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('GET /api/health is live', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('GET /api/health/ready checks PostgreSQL', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/health/ready')
      .expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
  });
});
