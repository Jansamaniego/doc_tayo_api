import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

export type RequestWithId = Request & { requestId?: string };

/**
 * Registered as raw Express middleware before the body parsers so that even
 * parse errors carry a request id. Overwrites the inbound header with the
 * sanitized value so later readers (including Observe) cannot see the raw one.
 */
export function requestIdMiddleware(
  req: RequestWithId,
  res: Response,
  next: NextFunction,
) {
  const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
  req.requestId = requestId;
  req.headers[REQUEST_ID_HEADER] = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * One access-log line per request. Logs the path WITHOUT its query string
 * (queries can contain patient search terms) and never headers or bodies.
 */
export function accessLogMiddleware(logger: {
  log: (message: unknown, context?: string) => void;
}) {
  return (req: RequestWithId, res: Response, next: NextFunction) => {
    const startedAt = performance.now();
    res.on('finish', () => {
      logger.log(
        {
          message: 'request completed',
          requestId: req.requestId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          statusCode: res.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'HTTP',
      );
    });
    next();
  };
}
