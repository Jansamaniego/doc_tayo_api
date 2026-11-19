import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CleanupService } from './cleanup.service.js';

/** Daily at 03:00 Manila time (the clinics' night). */
@Injectable()
export class CleanupJob {
  private readonly logger = new Logger(CleanupJob.name);

  constructor(private readonly cleanup: CleanupService) {}

  @Cron('0 3 * * *', { name: 'auth-cleanup', timeZone: 'Asia/Manila' })
  async run(): Promise<void> {
    try {
      await this.cleanup.run();
    } catch (error) {
      // Never crash the process for housekeeping; the next night retries.
      this.logger.error(
        { message: 'cleanup failed', errorName: (error as Error)?.name },
        (error as Error)?.stack,
      );
    }
  }
}
