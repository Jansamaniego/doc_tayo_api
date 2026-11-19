import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MailModule } from '../mail/mail.module.js';
import { TenantsModule } from '../tenants/tenants.module.js';
import { InvitationsController } from './invitations.controller.js';
import { InvitationsService } from './invitations.service.js';

@Module({
  imports: [AuditModule, MailModule, TenantsModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
})
export class MembersModule {}
