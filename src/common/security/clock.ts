import { Global, Injectable, Module } from '@nestjs/common';

/**
 * Injectable time source. Anything that compares against "now" for expiry
 * (sessions, tokens, lockout) uses this, so tests move time instead of sleeping.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }],
  exports: [Clock],
})
export class ClockModule {}
