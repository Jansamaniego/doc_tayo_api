import {
  ConsoleLogger,
  NotFoundException,
  Logger,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { ErrorResponse } from './common/dto/error-response.dto.js';
import { finishOpenApiDocument } from './common/http/openapi.js';
import { toApiError } from './common/errors/to-api-error.js';
import { validationExceptionFactory } from './common/errors/validation.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import {
  type RequestWithId,
  accessLogMiddleware,
  requestIdMiddleware,
} from './common/http/request-id.middleware.js';
import {
  appConfig,
  corsConfig,
  loggingConfig,
  swaggerConfig,
} from './config/configuration.js';

export const API_PREFIX = 'api';
export const DOCS_PATH = `${API_PREFIX}/docs`;
const JSON_BODY_LIMIT = '1mb';

/**
 * The OpenAPI document of the running app (paths include the global prefix and
 * URI version). Used by Swagger UI and by `npm run openapi:export`, which
 * writes `docs/openapi.json`, the contract handed to the frontend.
 */
export function buildOpenApiDocument(app: NestExpressApplication) {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('DocTayo API')
      .setDescription(
        'Clinic management backend. Errors use { error: { status, code, message, details?, requestId } }.',
      )
      .setVersion('1')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .build(),
    { extraModels: [ErrorResponse] },
  );
  return finishOpenApiDocument(document);
}

/**
 * Applies every global concern. Used by main.ts AND by the e2e tests, so tests
 * exercise the real prefix, versioning, pipes, filter, headers and CORS.
 */
export function applyAppSetup(app: NestExpressApplication): void {
  const application = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  const cors = app.get<ConfigType<typeof corsConfig>>(corsConfig.KEY);
  const logging = app.get<ConfigType<typeof loggingConfig>>(loggingConfig.KEY);
  const swagger = app.get<ConfigType<typeof swaggerConfig>>(swaggerConfig.KEY);
  const isProduction = application.env === 'production';

  // Logging: structured JSON in production, readable text in development.
  app.useLogger(
    new ConsoleLogger({
      json: logging.format === 'json',
      colors: logging.format === 'pretty',
      logLevels: logging.levels,
    }),
  );

  app.set('trust proxy', application.trustProxy);
  app.disable('x-powered-by');

  // Request id first (before body parsers), then the access log.
  app.use(requestIdMiddleware);
  app.use(accessLogMiddleware(new Logger()));

  // Security headers. Swagger UI needs inline scripts/styles, so the docs path
  // alone gets a relaxed CSP; every API route keeps Helmet's strict default.
  const strictHelmet = helmet({
    strictTransportSecurity: isProduction,
  });
  const docsHelmet = helmet({
    strictTransportSecurity: isProduction,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
      },
    },
  });
  app.use((req: Request, res: Response, next: NextFunction) =>
    req.path.startsWith(`/${DOCS_PATH}`)
      ? docsHelmet(req, res, next)
      : strictHelmet(req, res, next),
  );

  // Responses that carry or reveal credentials must never be cached by the
  // browser or a proxy: every sign-in endpoint and the signed-in user's account.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      req.path.startsWith(`/${API_PREFIX}/v1/auth/`) ||
      req.path.startsWith(`/${API_PREFIX}/v1/me`)
    ) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.enableCors({
    origin: cors.allowedOrigins.length > 0 ? cors.allowedOrigins : false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'Idempotency-Key',
    ],
    // Browsers hide other response headers from cross-origin code, and the
    // frontend needs Retry-After to tell a throttled user how long to wait.
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: cors.allowCredentials,
    maxAge: 600,
  });

  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // Reads the HttpOnly refresh cookie (auth endpoints only look at it).
  app.use(cookieParser());

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      exceptionFactory: validationExceptionFactory,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  if (swagger.enabled) {
    SwaggerModule.setup(DOCS_PATH, app, buildOpenApiDocument(app));
  }

  app.enableShutdownHooks();
}

/**
 * Call after `app.init()`. Nest only answers unmatched routes under the global
 * prefix; anything else (e.g. `/health`) would get Express's HTML 404. This
 * last handler gives every unmatched request the standard error shape.
 */
export function applyPostInit(app: NestExpressApplication): void {
  app
    .getHttpAdapter()
    .getInstance()
    .use((req: RequestWithId, res: Response) => {
      const error = toApiError(
        new NotFoundException(`Cannot ${req.method} ${req.path}`),
      );
      res
        .status(error.status)
        .json({ error: { ...error, requestId: req.requestId } });
    });
}
