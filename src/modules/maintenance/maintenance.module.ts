import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CleanupJob } from './cleanup.job.js';
import { CleanupService } from './cleanup.service.js';

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [CleanupService, CleanupJob],
  exports: [CleanupService],
})
export class MaintenanceModule {}
