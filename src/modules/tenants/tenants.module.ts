import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MailModule } from '../mail/mail.module.js';
import { TenantController } from './tenant.controller.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import { TenantOnboardingService } from './tenant-onboarding.service.js';
import { TenantProfileService } from './tenant-profile.service.js';

@Module({
  imports: [AuditModule, AuthModule, MailModule],
  controllers: [TenantController],
  providers: [
    TenantOnboardingService,
    TenantLifecycleService,
    TenantProfileService,
  ],
  exports: [
    TenantOnboardingService,
    TenantLifecycleService,
    TenantProfileService,
  ],
})
export class TenantsModule {}
