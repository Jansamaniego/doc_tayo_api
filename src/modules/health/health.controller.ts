import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator.js';
import { DatabaseHealthIndicator } from './database.health.js';

@Public()
@SkipThrottle({ default: true })
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
  ) {}

  /** Liveness: the process is up. Deliberately checks no dependencies. */
  @Get()
  @ApiOkResponse({
    description: 'The process is alive.',
    schema: { example: { status: 'ok' } },
  })
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the database answers a real query. */
  @Get('ready')
  @HealthCheck()
  @ApiOkResponse({ description: 'The service can reach PostgreSQL.' })
  @ApiServiceUnavailableResponse({
    description: 'PostgreSQL is unreachable (standard error shape, NOT_READY).',
  })
  ready() {
    return this.health.check([() => this.database.check('database')]);
  }
}
