import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { InMemoryMailTransport, MailTransport } from '@nestjs/mail';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { TestController } from '../support/test.controller.js';
import { TenantTestController } from '../support/tenant-test.controller.js';
import { ResettableThrottlerStorage } from '../support/resettable-throttler-storage.js';
import { TestAuthenticator } from '../support/test-authenticator.js';
import { AUTHENTICATOR } from '../../src/common/auth/authenticator.js';
import { AppModule } from '../../src/app.module.js';
import { Clock } from '../../src/common/security/clock.js';
import { applyAppSetup, applyPostInit } from '../../src/app.setup.js';

interface Options {
  /** Environment overrides applied for this app only. */
  env?: Record<string, string | undefined>;
  /** Test-only controllers (never imported by src/). */
  controllers?: Type<unknown>[];
  /** Keep the production authenticator (JwtAuthenticator) instead of TestAuthenticator. */
  productionAuthenticator?: boolean;
  /** Leave out the test-only controllers (a clean app, as in production). */
  omitTestControllers?: boolean;
  /** Replaces the system clock (expiry tests move time instead of sleeping). */
  clock?: Clock;
}

/** Builds the real AppModule configured by the real applyAppSetup. */
export async function createTestApp(
  options: Options = {},
): Promise<NestExpressApplication> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    const builder = Test.createTestingModule({
      imports: [AppModule],
      controllers: options.omitTestControllers
        ? []
        : [
            TestController,
            TenantTestController,
            ...(options.controllers ?? []),
          ],
    });
    if (!options.productionAuthenticator) {
      builder.overrideProvider(AUTHENTICATOR).useClass(TestAuthenticator);
    }
    builder
      .overrideProvider(MailTransport)
      .useValue(new InMemoryMailTransport())
      .overrideProvider(ThrottlerStorage)
      .useValue(new ResettableThrottlerStorage());
    if (options.clock) builder.overrideProvider(Clock).useValue(options.clock);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>();
    applyAppSetup(app);
    await app.init();
    applyPostInit(app);
    return app;
  } finally {
    // Config is read during compile/setup; restore the environment afterwards.
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export type { INestApplication };
