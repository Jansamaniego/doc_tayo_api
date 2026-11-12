import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyAppSetup, applyPostInit } from './app.setup.js';
import { appConfig } from './config/configuration.js';
import { AppModule } from './app.module.js';
import { ObserveInstrument } from './observability/observe.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    instrument: ObserveInstrument,
    bufferLogs: true,
  });
  applyAppSetup(app);
  await app.init();
  applyPostInit(app);
  const { port } = app.get<ConfigType<typeof appConfig>>(appConfig.KEY);
  await app.listen(port);
}
await bootstrap();
