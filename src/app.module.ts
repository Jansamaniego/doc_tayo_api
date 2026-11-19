import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { AppConfigModule } from './config/app-config.module.js';
import { appConfig, observeConfig } from './config/configuration.js';
import { ClockModule } from './common/security/clock.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { BranchesModule } from './modules/branches/branches.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { MembersModule } from './modules/members/members.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { TenantsModule } from './modules/tenants/tenants.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { TenancyModule } from './modules/tenancy/tenancy.module.js';
import { buildObserveOptions, ObserveModule } from './observability/observe.js';

@Module({
  imports: [
    AppConfigModule,
    ClockModule,
    PrismaModule,
    TenancyModule,
    AuditModule,
    TenantsModule,
    BranchesModule,
    UsersModule,
    MembersModule,
    MaintenanceModule,
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
