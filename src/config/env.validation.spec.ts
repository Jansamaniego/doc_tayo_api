import { parseEnv } from './env.validation.js';

const valid = {
  DATABASE_URL: 'postgresql://doctayo_app:pw@localhost:5433/doc_tayo',
};
const production = {
  ...valid,
  NODE_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  DATABASE_SSL: 'require',
  OBSERVE_APP_KEY: 'key',
  OBSERVE_APP_SECRET: 'secret',
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
