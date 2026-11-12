import 'reflect-metadata';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';
import type { LogLevel } from '@nestjs/common';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const BOOLEAN_STRINGS = ['true', 'false'];
const DB_SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type DatabaseSslMode = (typeof DB_SSL_MODES)[number];
const LOG_LEVEL_NAMES = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
const LOG_FORMATS = ['pretty', 'json'] as const;

/** Declares and validates every environment variable the API reads. */
class EnvironmentVariables {
  @IsOptional() @IsIn([...NODE_ENVS]) NODE_ENV?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsOptional()
  @Matches(/^(false|loopback|\d{1,2})$/)
  TRUST_PROXY?: string;

  @Matches(/^postgres(ql)?:\/\/\S+$/) DATABASE_URL!: string;

  @IsOptional()
  @Matches(/^[a-z_][a-z0-9_]{0,62}$/)
  DATABASE_SCHEMA?: string;

  @IsOptional() @IsIn([...DB_SSL_MODES]) DATABASE_SSL?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  DATABASE_POOL_MAX?: number;

  @IsOptional() @IsString() CORS_ALLOWED_ORIGINS?: string;
  @IsOptional() @IsIn(BOOLEAN_STRINGS) CORS_ALLOW_CREDENTIALS?: string;

  @IsOptional() @IsIn([...LOG_LEVEL_NAMES]) LOG_LEVEL?: string;
  @IsOptional() @IsIn([...LOG_FORMATS]) LOG_FORMAT?: string;

  @IsOptional() @IsIn(BOOLEAN_STRINGS) SWAGGER_ENABLED?: string;

  @IsOptional() @IsIn(BOOLEAN_STRINGS) OBSERVE_ENABLED?: string;
  @IsOptional() @IsString() OBSERVE_APP_KEY?: string;
  @IsOptional() @IsString() OBSERVE_APP_SECRET?: string;
}

export interface AppEnv {
  app: { env: NodeEnv; port: number; trustProxy: boolean | number | string };
  database: {
    url: string;
    schema: string;
    ssl: DatabaseSslMode;
    poolMax: number;
  };
  cors: { allowedOrigins: string[]; allowCredentials: boolean };
  logging: { levels: LogLevel[]; format: 'pretty' | 'json' };
  swagger: { enabled: boolean };
  observe: { enabled: boolean; appKey?: string; appSecret?: string };
}

const PLACEHOLDERS = new Set([
  '',
  '<set-me>',
  'YOUR_APP_KEY',
  'YOUR_APP_SECRET',
]);

const LEVELS: Record<(typeof LOG_LEVEL_NAMES)[number], LogLevel[]> = {
  error: ['error', 'fatal'],
  warn: ['warn', 'error', 'fatal'],
  log: ['log', 'warn', 'error', 'fatal'],
  debug: ['debug', 'log', 'warn', 'error', 'fatal'],
  verbose: ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'],
};

const ORIGIN_PATTERN = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;

/**
 * Validates raw environment variables and returns typed, defaulted config.
 * Throws an Error that names the offending variables and never includes their
 * values (values can be secrets).
 */
export function parseEnv(raw: Record<string, unknown>): AppEnv {
  const vars = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
  });
  const problems = validateSync(vars, {
    skipMissingProperties: false,
    forbidUnknownValues: false,
  }).flatMap((error) =>
    Object.values(error.constraints ?? { invalid: 'is invalid' }).map(
      (message) =>
        `${error.property}: ${message.replace(error.property, '').trim() || 'is invalid'}`,
    ),
  );

  const env = (vars.NODE_ENV ?? 'development') as NodeEnv;
  const isProduction = env === 'production';

  const allowedOrigins = (vars.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (allowedOrigins.some((origin) => !ORIGIN_PATTERN.test(origin))) {
    problems.push(
      'CORS_ALLOWED_ORIGINS: must be comma-separated exact origins (scheme://host[:port], no wildcard, path, or trailing slash)',
    );
  }
  if (isProduction && allowedOrigins.length === 0) {
    problems.push('CORS_ALLOWED_ORIGINS: required in production');
  }

  const ssl = (vars.DATABASE_SSL ??
    (isProduction ? 'require' : 'disable')) as DatabaseSslMode;
  if (isProduction && ssl === 'disable') {
    problems.push('DATABASE_SSL: must not be "disable" in production');
  }

  const observeEnabled = vars.OBSERVE_ENABLED
    ? vars.OBSERVE_ENABLED === 'true'
    : isProduction;
  if (
    observeEnabled &&
    (PLACEHOLDERS.has(vars.OBSERVE_APP_KEY ?? '') ||
      PLACEHOLDERS.has(vars.OBSERVE_APP_SECRET ?? ''))
  ) {
    problems.push(
      'OBSERVE_APP_KEY / OBSERVE_APP_SECRET: required when OBSERVE_ENABLED is true',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  const trustProxyRaw = vars.TRUST_PROXY ?? 'false';

  return {
    app: {
      env,
      port: vars.PORT ?? 3000,
      trustProxy:
        trustProxyRaw === 'false'
          ? false
          : trustProxyRaw === 'loopback'
            ? 'loopback'
            : Number(trustProxyRaw),
    },
    database: {
      url: vars.DATABASE_URL,
      schema: vars.DATABASE_SCHEMA ?? 'public',
      ssl,
      poolMax: vars.DATABASE_POOL_MAX ?? 10,
    },
    cors: {
      allowedOrigins,
      allowCredentials: vars.CORS_ALLOW_CREDENTIALS === 'true',
    },
    logging: {
      levels:
        LEVELS[
          (vars.LOG_LEVEL ??
            (env === 'production'
              ? 'log'
              : env === 'test'
                ? 'error'
                : 'debug')) as keyof typeof LEVELS
        ],
      format: (vars.LOG_FORMAT ?? (isProduction ? 'json' : 'pretty')) as
        'pretty' | 'json',
    },
    swagger: {
      enabled: vars.SWAGGER_ENABLED
        ? vars.SWAGGER_ENABLED === 'true'
        : !isProduction,
    },
    observe: {
      enabled: observeEnabled,
      appKey: vars.OBSERVE_APP_KEY,
      appSecret: vars.OBSERVE_APP_SECRET,
    },
  };
}
