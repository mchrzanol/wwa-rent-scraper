import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PlaywrightModule } from './playwright/playwright.module';
import { DatabaseModule } from './database/database.module';
import { RoutingModule } from './routing/routing.module';
import { AiModule } from './ai/ai.module';
import { DeduplicationModule } from './deduplication/deduplication.module';
import { ScrapersModule } from './scrapers/scrapers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SheetsModule } from './sheets/sheets.module';
import { CronModule } from './cron/cron.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PlaywrightModule,        // @Global → APP_CONFIG, ProxyRotationService, PlaywrightService
    DatabaseModule,          // @Global → PrismaService
    RoutingModule,
    AiModule,
    DeduplicationModule,
    ScrapersModule,
    NotificationsModule,
    SheetsModule,
    CronModule,
    HealthModule,
  ],
})
export class AppModule {}
