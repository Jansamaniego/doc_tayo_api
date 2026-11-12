import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';

const ALLOWED = 'http://localhost:5173';

describe('HTTP security (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({
      env: {
        CORS_ALLOWED_ORIGINS: ALLOWED,
        CORS_ALLOW_CREDENTIALS: 'false',
        SWAGGER_ENABLED: 'true',
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  it('sets security headers on API routes and hides the framework', async () => {
    const res = await http().get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(res.headers['content-security-policy']).toContain(
      "script-src 'self';",
    );
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined(); // non-production
  });

  it('relaxes CSP only for the Swagger UI path', async () => {
    const res = await http().get('/api/docs/').expect(200);
    expect(res.headers['content-security-policy']).toContain("'unsafe-inline'");
  });

  it('allows a configured origin on preflight', async () => {
    const res = await http()
      .options('/api/v1/_test/items')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,authorization')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    expect(res.headers['vary']).toContain('Origin');
  });

  it('exposes the request id header to browsers', async () => {
    const res = await http().get('/api/health').set('Origin', ALLOWED);
    expect(res.headers['access-control-expose-headers']).toContain(
      'X-Request-Id',
    );
  });

  it('gives a disallowed origin no CORS headers and never a wildcard', async () => {
    const res = await http()
      .options('/api/v1/_test/items')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const get = await http()
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
  });
});
