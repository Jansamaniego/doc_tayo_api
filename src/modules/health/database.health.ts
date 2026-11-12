import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Reports only up/down. Driver messages can contain hosts or credentials, so
 * no error text ever reaches the response.
 */
@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly indicators: HealthIndicatorService,
  ) {}

  async check(key: string, timeoutMs = 1000) {
    const indicator = this.indicators.check(key);
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), timeoutMs).unref(),
        ),
      ]);
      return indicator.up();
    } catch {
      return indicator.down();
    }
  }
}
