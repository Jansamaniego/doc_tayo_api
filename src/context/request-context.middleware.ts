import type { NextFunction, Response } from 'express';
import type { RequestWithId } from '../common/http/request-id.middleware.js';
import { RequestContext } from './request-context.js';

/**
 * Opens the per-request context. Registered from TenancyModule.configure() so
 * Nest mounts it AFTER the body parsers: Node loses AsyncLocalStorage context
 * across the socket events body-parser waits on, so a store opened earlier
 * would be gone by the time guards run on requests that have a body.
 */
export function requestContextMiddleware(
  req: RequestWithId,
  _res: Response,
  next: NextFunction,
): void {
  RequestContext.run({ requestId: req.requestId, ip: req.ip }, () => next());
}
