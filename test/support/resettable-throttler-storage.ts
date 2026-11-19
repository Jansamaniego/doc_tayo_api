import { ThrottlerStorageService } from '@nestjs/throttler';

/**
 * In-memory throttler storage that tests can empty between cases. The real
 * rate limits stay in force; suites that log in many times from one IP reset
 * the counters instead of weakening the limits.
 */
export class ResettableThrottlerStorage extends ThrottlerStorageService {
  reset(): void {
    this.storage.clear();
    // Hit timestamps live in a second private map; stale entries would leak
    // into the next count, so clear both.
    (
      this as unknown as { hitExpirations: Map<string, unknown> }
    ).hitExpirations.clear();
  }
}
