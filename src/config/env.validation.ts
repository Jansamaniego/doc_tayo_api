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
  MinLength,
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
const MAIL_TRANSPORTS = ['log', 'file', 'memory', 'smtp'] as const;
export type MailTransportName = (typeof MAIL_TRANSPORTS)[number];
const DURATION = /^(\d+)([smhd])$/;
const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

/** OWASP baseline (plans/02-authentication.md §8.1); production may not go below it. */
const ARGON2_BASELINE = { memoryKib: 19456, timeCost: 2, parallelism: 1 };

/** `15m`, `14d`, ... -> seconds, or null when malformed. */
function parseDuration(value: string): number | null {
  const match = DURATION.exec(value);
  if (!match) return null;
  return Number(match[1]) * DURATION_UNITS[match[2] as 's' | 'm' | 'h' | 'd'];
}

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

  @IsString() @MinLength(32) JWT_ACCESS_SECRET!: string;
  @IsOptional() @Matches(DURATION) JWT_ACCESS_TTL?: string;
  @IsOptional() @Matches(DURATION) SESSION_IDLE_TTL?: string;
  @IsOptional() @Matches(DURATION) SESSION_ABSOLUTE_TTL?: string;
  @IsOptional()
  @Matches(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/)
  APP_PUBLIC_URL?: string;

  @IsOptional() @IsIn([...MAIL_TRANSPORTS]) MAIL_TRANSPORT?: string;
  @IsOptional() @IsString() SMTP_URL?: string;
  @IsOptional() @IsString() MAIL_FROM?: string;
  @IsOptional() @IsIn(['on', 'off']) OUTBOX_RELAY?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) ARGON2_MEMORY_KIB?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) ARGON2_TIME_COST?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  ARGON2_PARALLELISM?: number;
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
  auth: {
    jwt: { secret: string; accessTtlSeconds: number };
    session: { idleTtlSeconds: number; absoluteTtlSeconds: number };
    argon2: { memoryKib: number; timeCost: number; parallelism: number };
    /** Frontend base URL used in emailed links. */
    appPublicUrl: string;
    /** `Secure` flag of the refresh cookie (everywhere except development). */
    cookieSecure: boolean;
  };
  mail: {
    transport: MailTransportName;
    from?: string;
    smtpUrl?: string;
    /** Run the outbox relay in this process (`OUTBOX_RELAY=off` disables it). */
    outboxRelay: boolean;
  };
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

  // --- Authentication --------------------------------------------------------
  const durations = {
    JWT_ACCESS_TTL: vars.JWT_ACCESS_TTL ?? '15m',
    SESSION_IDLE_TTL: vars.SESSION_IDLE_TTL ?? '14d',
    SESSION_ABSOLUTE_TTL: vars.SESSION_ABSOLUTE_TTL ?? '30d',
  };
  const accessTtl = parseDuration(durations.JWT_ACCESS_TTL) ?? 900;
  const idleTtl = parseDuration(durations.SESSION_IDLE_TTL) ?? 14 * 86400;
  const absoluteTtl =
    parseDuration(durations.SESSION_ABSOLUTE_TTL) ?? 30 * 86400;
  if (accessTtl < 300 || accessTtl > 3600) {
    problems.push('JWT_ACCESS_TTL: must be between 5 and 60 minutes');
  }
  if (absoluteTtl < idleTtl) {
    problems.push(
      'SESSION_ABSOLUTE_TTL: must not be shorter than SESSION_IDLE_TTL',
    );
  }

  const argon2 = {
    memoryKib: vars.ARGON2_MEMORY_KIB ?? ARGON2_BASELINE.memoryKib,
    timeCost: vars.ARGON2_TIME_COST ?? ARGON2_BASELINE.timeCost,
    parallelism: vars.ARGON2_PARALLELISM ?? ARGON2_BASELINE.parallelism,
  };
  if (isProduction) {
    if (argon2.memoryKib < ARGON2_BASELINE.memoryKib) {
      problems.push('ARGON2_MEMORY_KIB: below the production minimum');
    }
    if (argon2.timeCost < ARGON2_BASELINE.timeCost) {
      problems.push('ARGON2_TIME_COST: below the production minimum');
    }
    if (argon2.parallelism < ARGON2_BASELINE.parallelism) {
      problems.push('ARGON2_PARALLELISM: below the production minimum');
    }
    if (!vars.APP_PUBLIC_URL)
      problems.push('APP_PUBLIC_URL: required in production');
    if (!vars.MAIL_FROM) problems.push('MAIL_FROM: required in production');
  }

  const mailTransport = (vars.MAIL_TRANSPORT ??
    (env === 'test' ? 'memory' : 'log')) as MailTransportName;
  if (isProduction && mailTransport !== 'smtp') {
    problems.push(
      'MAIL_TRANSPORT: must be "smtp" in production (log, file and memory are for development and tests)',
    );
  }
  if (mailTransport === 'smtp' && !vars.SMTP_URL) {
    problems.push('SMTP_URL: required when MAIL_TRANSPORT is "smtp"');
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
    auth: {
      jwt: { secret: vars.JWT_ACCESS_SECRET, accessTtlSeconds: accessTtl },
      session: { idleTtlSeconds: idleTtl, absoluteTtlSeconds: absoluteTtl },
      argon2,
      appPublicUrl: vars.APP_PUBLIC_URL ?? 'http://localhost:5173',
      cookieSecure: env !== 'development',
    },
    mail: {
      transport: mailTransport,
      from: vars.MAIL_FROM,
      smtpUrl: vars.SMTP_URL,
      outboxRelay: vars.OUTBOX_RELAY !== 'off',
    },
  };
}
