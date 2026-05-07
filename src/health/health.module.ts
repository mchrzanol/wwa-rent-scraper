import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CronModule } from '../cron/cron.module';

@Module({
  imports: [CronModule],
  controllers: [HealthController],
})
export class HealthModule {}
