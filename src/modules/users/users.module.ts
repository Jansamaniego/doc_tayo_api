import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [MeController],
  providers: [MeService],
})
export class UsersModule {}
