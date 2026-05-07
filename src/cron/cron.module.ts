import { Module } from '@nestjs/common';
import { ScrapersModule } from '../scrapers/scrapers.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SheetsModule } from '../sheets/sheets.module';
import { ScrapeCron } from './scrape.cron';

@Module({
  imports: [ScrapersModule, NotificationsModule, SheetsModule],
  providers: [ScrapeCron],
  exports: [ScrapeCron],
})
export class CronModule {}
