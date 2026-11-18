import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { TenantController } from './tenant.controller.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import { TenantOnboardingService } from './tenant-onboarding.service.js';
import { TenantProfileService } from './tenant-profile.service.js';

@Module({
  imports: [AuditModule],
  controllers: [TenantController],
  providers: [
    TenantOnboardingService,
    TenantLifecycleService,
    TenantProfileService,
  ],
  exports: [TenantOnboardingService, TenantLifecycleService],
})
export class TenantsModule {}
