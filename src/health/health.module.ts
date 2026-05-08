import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CronModule } from '../cron/cron.module';
import { SheetsModule } from '../sheets/sheets.module';

@Module({
  imports: [CronModule, SheetsModule],
  controllers: [HealthController],
})
export class HealthModule {}
