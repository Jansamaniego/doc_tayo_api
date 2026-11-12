import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './setup/create-test-app.js';

describe('Swagger (e2e)', () => {
  it('serves docs and a correct OpenAPI document when enabled', async () => {
    const app = await createTestApp({ env: { SWAGGER_ENABLED: 'true' } });
    try {
      const html = await request(app.getHttpServer())
        .get('/api/docs')
        .redirects(1)
        .expect(200);
      expect(html.text).toContain('swagger');
      const json = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      const paths = Object.keys(json.body.paths);
      expect(paths).toEqual(
        expect.arrayContaining(['/api/health', '/api/health/ready']),
      );
      expect(
        paths.some((p) => p.includes('/api/api') || p.includes('/v1/v1')),
      ).toBe(false);
      await request(app.getHttpServer()).get('/api/api/docs').expect(404);
    } finally {
      await app.close();
    }
  });

  it('is not served when disabled', async () => {
    const app: NestExpressApplication = await createTestApp({
      env: { SWAGGER_ENABLED: 'false' },
    });
    try {
      await request(app.getHttpServer()).get('/api/docs').expect(404);
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    } finally {
      await app.close();
    }
  });
});
