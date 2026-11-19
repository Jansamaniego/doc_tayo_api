import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';

const FRONTEND = 'http://localhost:5173';

/**
 * What a browser does for the cookie-based refresh flow: a credentialed
 * cross-origin request, preceded by a preflight. The frontend cannot work
 * unless every header below is exactly right.
 */
describe('CORS with credentials, as a browser exercises it (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({
      productionAuthenticator: true,
      env: { CORS_ALLOWED_ORIGINS: FRONTEND, CORS_ALLOW_CREDENTIALS: 'true' },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('the preflight for POST /auth/refresh allows the frontend origin with credentials (never a wildcard)', async () => {
    const res = await http()
      .options('/api/v1/auth/refresh')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('the preflight allows the Authorization header the access token travels in', async () => {
    const res = await http()
      .options('/api/v1/me')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(
      res.headers['access-control-allow-headers']?.toLowerCase(),
    ).toContain('authorization');
  });

  it('a credentialed response carries allow-origin and allow-credentials (without them the browser discards it)', async () => {
    const res = await http()
      .post('/api/v1/auth/login')
      .set('Origin', FRONTEND)
      .send({ email: 'nobody@example.com', password: 'whatever password' })
      .expect(401);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('exposes Retry-After and X-Request-Id, otherwise browser code cannot read them', async () => {
    const res = await http()
      .options('/api/v1/auth/login')
      .set('Origin', FRONTEND)
      .set('Access-Control-Request-Method', 'POST');
    const exposed = String(
      res.headers['access-control-expose-headers'],
    ).toLowerCase();
    expect(exposed).toContain('x-request-id');
    expect(exposed).toContain('retry-after');
  });

  it('a 429 reaches the browser with Retry-After and the CORS headers it needs to read it', async () => {
    for (let i = 0; i < 5; i++) {
      await http()
        .post('/api/v1/auth/login')
        .set('Origin', FRONTEND)
        .send({
          email: 'cors-throttle@example.com',
          password: 'whatever password',
        })
        .expect(401);
    }
    const res = await http()
      .post('/api/v1/auth/login')
      .set('Origin', FRONTEND)
      .send({
        email: 'cors-throttle@example.com',
        password: 'whatever password',
      })
      .expect(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('a foreign origin is never allowed', async () => {
    const res = await http()
      .options('/api/v1/auth/refresh')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    // Without allow-origin the browser blocks the response, whatever else is sent.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
