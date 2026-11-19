import { parseEnv } from './env.validation.js';

const SECRET = 'x'.repeat(48);
const valid = {
  DATABASE_URL: 'postgresql://doctayo_app:pw@localhost:5433/doc_tayo',
  JWT_ACCESS_SECRET: SECRET,
};
const production = {
  ...valid,
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  DATABASE_SSL: 'require',
  OBSERVE_APP_KEY: 'key',
  OBSERVE_APP_SECRET: 'secret',
  APP_PUBLIC_URL: 'https://app.example.com',
  MAIL_TRANSPORT: 'smtp',
  SMTP_URL: 'smtps://user:pw@smtp.example.com:465',
  MAIL_FROM: 'DocTayo <no-reply@example.com>',
};

describe('parseEnv', () => {
  it('accepts a minimal valid environment and applies safe defaults', () => {
    const env = parseEnv(valid);
    expect(env.app).toMatchObject({
      env: 'development',
      port: 3000,
      trustProxy: false,
    });
    expect(env.database).toMatchObject({
      schema: 'public',
      ssl: 'disable',
      poolMax: 10,
    });
    expect(env.cors).toEqual({ allowedOrigins: [], allowCredentials: false });
    expect(env.swagger.enabled).toBe(true);
    expect(env.observe.enabled).toBe(false);
    expect(env.logging.format).toBe('pretty');
  });

  it('uses production defaults', () => {
    const env = parseEnv(production);
    expect(env.swagger.enabled).toBe(false);
    expect(env.observe.enabled).toBe(true);
    expect(env.logging.format).toBe('json');
  });

  it.each([
    ['missing DATABASE_URL', {}, 'DATABASE_URL'],
    [
      'non-postgres DATABASE_URL',
      { DATABASE_URL: 'mysql://x/y' },
      'DATABASE_URL',
    ],
    ['bad PORT', { ...valid, PORT: 'abc' }, 'PORT'],
    ['PORT out of range', { ...valid, PORT: '70000' }, 'PORT'],
    ['bad NODE_ENV', { ...valid, NODE_ENV: 'staging' }, 'NODE_ENV'],
    ['bad boolean', { ...valid, SWAGGER_ENABLED: 'maybe' }, 'SWAGGER_ENABLED'],
    [
      'wildcard CORS origin',
      { ...valid, CORS_ALLOWED_ORIGINS: '*' },
      'CORS_ALLOWED_ORIGINS',
    ],
    [
      'CORS origin with path',
      { ...valid, CORS_ALLOWED_ORIGINS: 'https://a.com/x' },
      'CORS_ALLOWED_ORIGINS',
    ],
    [
      'production without CORS origins',
      { ...production, CORS_ALLOWED_ORIGINS: '' },
      'CORS_ALLOWED_ORIGINS',
    ],
    [
      'production with DATABASE_SSL=disable',
      { ...production, DATABASE_SSL: 'disable' },
      'DATABASE_SSL',
    ],
    [
      'Observe enabled without keys',
      { ...valid, OBSERVE_ENABLED: 'true' },
      'OBSERVE_APP_KEY',
    ],
    [
      'Observe placeholder key',
      {
        ...valid,
        OBSERVE_ENABLED: 'true',
        OBSERVE_APP_KEY: '<set-me>',
        OBSERVE_APP_SECRET: 'x',
      },
      'OBSERVE_APP_KEY',
    ],
  ])('rejects %s', (_label, input, variable) => {
    expect(() => parseEnv(input)).toThrow(variable);
  });

  describe('authentication and mail', () => {
    it('applies the documented defaults', () => {
      const env = parseEnv(valid);
      expect(env.auth.jwt).toEqual({ secret: SECRET, accessTtlSeconds: 900 });
      expect(env.auth.session).toEqual({
        idleTtlSeconds: 14 * 86400,
        absoluteTtlSeconds: 30 * 86400,
      });
      expect(env.auth.argon2).toEqual({
        memoryKib: 19456,
        timeCost: 2,
        parallelism: 1,
      });
      expect(env.auth.appPublicUrl).toBe('http://localhost:5173');
      expect(env.auth.cookieSecure).toBe(false);
      expect(env.mail).toMatchObject({ transport: 'log', outboxRelay: true });
      expect(parseEnv({ ...valid, NODE_ENV: 'test' }).mail.transport).toBe(
        'memory',
      );
    });

    it('parses durations and the production cookie is Secure', () => {
      const env = parseEnv({
        ...production,
        JWT_ACCESS_TTL: '30m',
        SESSION_IDLE_TTL: '7d',
        SESSION_ABSOLUTE_TTL: '720h',
      });
      expect(env.auth.jwt.accessTtlSeconds).toBe(1800);
      expect(env.auth.session.idleTtlSeconds).toBe(7 * 86400);
      expect(env.auth.session.absoluteTtlSeconds).toBe(30 * 86400);
      expect(env.auth.cookieSecure).toBe(true);
    });

    it.each([
      ['missing JWT_ACCESS_SECRET', { DATABASE_URL: valid.DATABASE_URL }],
      ['short JWT_ACCESS_SECRET', { ...valid, JWT_ACCESS_SECRET: 'short' }],
      ['access TTL below 5 minutes', { ...valid, JWT_ACCESS_TTL: '4m' }],
      ['access TTL above 60 minutes', { ...valid, JWT_ACCESS_TTL: '61m' }],
      ['malformed duration', { ...valid, SESSION_IDLE_TTL: 'soon' }],
      [
        'absolute TTL below idle TTL',
        { ...valid, SESSION_IDLE_TTL: '10d', SESSION_ABSOLUTE_TTL: '5d' },
      ],
      ['bad MAIL_TRANSPORT', { ...valid, MAIL_TRANSPORT: 'pigeon' }],
      ['smtp without SMTP_URL', { ...valid, MAIL_TRANSPORT: 'smtp' }],
      ['bad APP_PUBLIC_URL', { ...valid, APP_PUBLIC_URL: 'not a url' }],
      ['bad OUTBOX_RELAY', { ...valid, OUTBOX_RELAY: 'maybe' }],
    ])('rejects %s', (_label, input) => {
      expect(() => parseEnv(input)).toThrow();
    });

    it.each([
      ['APP_PUBLIC_URL', { ...production, APP_PUBLIC_URL: undefined }],
      ['MAIL_FROM', { ...production, MAIL_FROM: undefined }],
      ['MAIL_TRANSPORT', { ...production, MAIL_TRANSPORT: 'log' }],
      ['MAIL_TRANSPORT', { ...production, MAIL_TRANSPORT: 'file' }],
      ['MAIL_TRANSPORT', { ...production, MAIL_TRANSPORT: 'memory' }],
      ['ARGON2_MEMORY_KIB', { ...production, ARGON2_MEMORY_KIB: '1024' }],
      ['ARGON2_TIME_COST', { ...production, ARGON2_TIME_COST: '1' }],
    ])('production requires a safe %s', (variable, input) => {
      expect(() => parseEnv(input)).toThrow(variable);
    });

    it('allows lowered Argon2 parameters outside production (fast tests)', () => {
      const env = parseEnv({
        ...valid,
        NODE_ENV: 'test',
        ARGON2_MEMORY_KIB: '1024',
        ARGON2_TIME_COST: '1',
      });
      expect(env.auth.argon2).toMatchObject({ memoryKib: 1024, timeCost: 1 });
    });

    it('never leaks the JWT secret in an error', () => {
      const secret = 'LEAKY-SECRET-SHORT';
      try {
        parseEnv({ ...valid, JWT_ACCESS_SECRET: secret });
        throw new Error('expected parseEnv to throw');
      } catch (error) {
        expect((error as Error).message).toContain('JWT_ACCESS_SECRET');
        expect((error as Error).message).not.toContain(secret);
      }
    });
  });

  it('names variables but never leaks their values', () => {
    const secret = 'S3CRET-VALUE-THAT-MUST-NOT-LEAK';
    try {
      parseEnv({
        DATABASE_URL: `mysql://user:${secret}@host/db`,
        PORT: secret,
      });
      throw new Error('expected parseEnv to throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('PORT');
      expect(message).not.toContain(secret);
    }
  });
});
