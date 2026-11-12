import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { captureOutput } from './setup/capture-output.js';
import { createTestApp } from './setup/create-test-app.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('Request id and logging (e2e)', () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await createTestApp({
      env: { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' },
    });
  });
  afterAll(async () => {
    await app.close();
  });
  const http = () => request(app.getHttpServer());

  it('generates a request id when none is sent', async () => {
    const res = await http().get('/api/health');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it('echoes a valid UUID request id', async () => {
    const id = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const res = await http().get('/api/health').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it.each([
    'not-a-uuid',
    'x'.repeat(300),
    '<script>alert(1)</script>',
    "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'; DROP TABLE x",
  ])('replaces an unsafe request id (%s)', async (bad) => {
    const capture = captureOutput();
    let res;
    try {
      res = await http()
        .get('/api/v1/_test/domain-error')
        .set('X-Request-Id', bad);
    } finally {
      capture.restore();
    }
    expect(res.headers['x-request-id']).toMatch(UUID);
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
    expect(capture.text()).not.toContain(bad);
    expect(capture.text()).toContain(res.headers['x-request-id']);
  });

  it('writes one access-log line with the request id and without the query string', async () => {
    const capture = captureOutput();
    let res;
    try {
      res = await http().get('/api/health?q=PHI-SEARCH-TERM-Juan');
    } finally {
      capture.restore();
    }
    const lines = capture
      .text()
      .split('\n')
      .filter((l) => l.includes('request completed'));
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.message).toMatchObject({
      requestId: res.headers['x-request-id'],
      method: 'GET',
      path: '/api/health',
      statusCode: 200,
    });
    expect(typeof entry.message.durationMs).toBe('number');
  });

  it('keeps sensitive request data and error text out of logs and responses', async () => {
    const markers = {
      password: 'PW-MARKER-hunter2',
      phi: 'PHI-MARKER-Juan-dela-Cruz',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwaGktbWFya2VyIn0.SIGNATURE-MARKER',
      cookie: 'COOKIE-MARKER-session',
      query: 'QUERY-MARKER-Maria',
    };
    const capture = captureOutput();
    const responses: string[] = [];
    try {
      const post = await http()
        .post('/api/v1/_test/items')
        .set('Authorization', `Bearer ${markers.jwt}`)
        .set('Cookie', `session=${markers.cookie}`)
        .send({
          email: 'bad',
          password: markers.password,
          firstName: markers.phi,
          quantity: 1,
          address: { city: 'x' },
        });
      responses.push(JSON.stringify(post.body));
      const boom = await http()
        .get(`/api/v1/_test/unexpected?q=${markers.query}`)
        .set('Authorization', `Bearer ${markers.jwt}`);
      responses.push(JSON.stringify(boom.body));
    } finally {
      capture.restore();
    }
    const logs = capture.text();
    for (const marker of Object.values(markers)) {
      expect(logs).not.toContain(marker);
      for (const body of responses) expect(body).not.toContain(marker);
    }
    // The server-side error log exists, but carries no request payload.
    expect(logs).toContain('INTERNAL_ERROR');
  });
});
