import { createHash } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from '@nestjs/common';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  ThrottlerStorage,
} from '@nestjs/throttler';
import type { Response } from 'express';
import { RequestContext } from '../../context/request-context.js';

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 5;

/**
 * Route-level limit PER USER (5 attempts per 15 minutes), counted in the same
 * store as the global throttler. It must run AFTER AuthGuard, so it is applied
 * with @UseGuards on the route (global guards run first). Used for
 * POST /me/password, where the abusive caller is a signed-in user guessing the
 * current password.
 */
@Injectable()
export class UserThrottleGuard implements CanActivate {
  constructor(
    @InjectThrottlerStorage() private readonly storage: ThrottlerStorage,
    private readonly context: RequestContext,
  ) {}

  async canActivate(execution: ExecutionContext): Promise<boolean> {
    const userId = this.context.requireUser();
    const key = createHash('sha256')
      .update(
        `${execution.getClass().name}-${execution.getHandler().name}-user-${userId}`,
      )
      .digest('hex');
    const record = await this.storage.increment(
      key,
      WINDOW_MS,
      LIMIT,
      WINDOW_MS,
      'user',
    );
    if (record.isBlocked) {
      execution
        .switchToHttp()
        .getResponse<Response>()
        .setHeader(
          'Retry-After',
          String(Math.max(1, record.timeToBlockExpire)),
        );
      throw new ThrottlerException();
    }
    return true;
  }
}
