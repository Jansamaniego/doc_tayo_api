import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithId } from '../http/request-id.middleware.js';
import { toApiError } from '../errors/to-api-error.js';

/**
 * The single place that turns a failure into the public error shape
 * `{ error: { status, code, message, details?, requestId } }`.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestWithId>();
    const response = http.getResponse<Response>();

    const error = toApiError(exception);
    const requestId = request.requestId;

    if (error.status >= 500) {
      // Server-side only. Observe redacts before anything leaves the process.
      this.logger.error(
        { requestId, code: error.code, errorName: (exception as Error)?.name },
        (exception as Error)?.stack,
      );
    }

    if (response.headersSent) return;
    response.status(error.status).json({ error: { ...error, requestId } });
  }
}
