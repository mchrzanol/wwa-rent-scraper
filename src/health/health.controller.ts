import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ScrapeCron } from '../cron/scrape.cron';
import { GoogleSheetsService } from '../sheets/google-sheets.service';

@Controller('test')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scrapeCron: ScrapeCron,
    private readonly sheets: GoogleSheetsService,
  ) {}

  @Get()
  async health(): Promise<{
    status: 'ok' | 'degraded';
    env: string;
    uptimeSeconds: number;
    db: 'up' | 'down';
    cycleRunning: boolean;
    timestamp: string;
  }> {
    let db: 'up' | 'down' = 'down';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch {
      db = 'down';
    }
    return {
      status: db === 'up' ? 'ok' : 'degraded',
      env: process.env.NODE_ENV ?? 'development',
      uptimeSeconds: Math.round(process.uptime()),
      db,
      cycleRunning: this.scrapeCron.isRunning(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Manually triggers one full scrape → dedup → routing → notify cycle.
   * Returns immediately (202) — cycle runs in the background; watch logs and
   * GET /test for `cycleRunning` status.
   */
  @Post('scrape')
  @HttpCode(HttpStatus.ACCEPTED)
  triggerScrape(
    @Query('pages') pages?: string,
  ): { triggered: boolean; alreadyRunning: boolean; maxPages: number } {
    if (this.scrapeCron.isRunning()) {
      return { triggered: false, alreadyRunning: true, maxPages: 0 };
    }
    const deepDefault = Number(process.env.DEEP_SCRAPE_PAGES ?? 5) || 5;
    const maxPages = Math.max(1, Number(pages ?? deepDefault) || deepDefault);
    this.scrapeCron.handle(maxPages).catch((err) => {
      this.logger.error(`Manual cycle failed: ${(err as Error).message}`);
    });
    return { triggered: true, alreadyRunning: false, maxPages };
  }

  /**
   * Wipes the sheet's data rows and re-emits every Listing in the DB with
   * the current row schema. Use after changing the row shape or to recover
   * a desynced sheet. Manual Status edits in the sheet are lost.
   */
  @Post('sheets/resync')
  async resyncSheet(): Promise<{ written: number }> {
    return this.sheets.resyncAllListings();
  }
}
