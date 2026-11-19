import { Clock } from '../../src/common/security/clock.js';

/** Controllable clock: tests move time instead of sleeping. */
export class TestClock extends Clock {
  private current: Date;

  constructor(start = new Date()) {
    super();
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
