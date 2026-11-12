import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AppConfigModule } from './config/app-config.module.js';
import { appConfig, observeConfig } from './config/configuration.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { buildObserveOptions, ObserveModule } from './observability/observe.js';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    HealthModule,
    ObserveModule.forRootAsync({
      inject: [observeConfig.KEY, appConfig.KEY],
      useFactory: (
        observe: ConfigType<typeof observeConfig>,
        app: ConfigType<typeof appConfig>,
      ) => buildObserveOptions(observe, app.env),
    }),
  ],
})
export class AppModule {}
