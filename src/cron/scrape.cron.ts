import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ScraperOrchestratorService } from '../scrapers/scraper-orchestrator.service';
import { DiscordService } from '../notifications/discord.service';
import { GoogleSheetsService } from '../sheets/google-sheets.service';

const SHALLOW_PAGES = 1;
const DEEP_PAGES = Number(process.env.DEEP_SCRAPE_PAGES ?? 5);

@Injectable()
export class ScrapeCron {
  private readonly logger = new Logger(ScrapeCron.name);
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  constructor(
    private readonly orchestrator: ScraperOrchestratorService,
    private readonly discord: DiscordService,
    private readonly sheets: GoogleSheetsService,
  ) {}

  /** Hourly shallow (1 page) 06–22, except 12:00 which runs the deep variant. */
  @Cron('0 6-11,13-22 * * *', { timeZone: 'Europe/Warsaw' })
  async hourly(): Promise<void> {
    await this.handle(SHALLOW_PAGES);
  }

  /** Daily deep scan at noon — walks DEEP_PAGES per portal × district. */
  @Cron('0 12 * * *', { timeZone: 'Europe/Warsaw' })
  async daily(): Promise<void> {
    this.logger.log(`Daily deep scan firing (${DEEP_PAGES} pages)`);
    await this.handle(DEEP_PAGES);
  }

  /**
   * Single-flight guard prevents overlap if a cycle ever runs longer than an
   * hour (deep scans on slow proxies often will).
   */
  async handle(maxPages = SHALLOW_PAGES): Promise<void> {
    if (this.running) {
      this.logger.warn('Previous cycle still running — skipping this tick');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    let report: import('../scrapers/scraper-orchestrator.service').OrchestratorReport | undefined;
    let cycleError: Error | undefined;

    try {
      report = await this.orchestrator.runCycle({ maxPages });
      this.logger.log(
        `Cycle outcomes — newListingIds=${report.newListingIds.length}, totals=${JSON.stringify(report.totals)}, rejectedByReason=${JSON.stringify(report.rejectedByReason)}`,
      );
      if (report.newListingIds.length) {
        this.logger.log(`→ Sheets appendListings (${report.newListingIds.length})`);
        await this.sheets.appendListings(report.newListingIds);
        this.logger.log(`→ Discord notifyMany (${report.newListingIds.length})`);
        await this.discord.notifyMany(report.newListingIds);
      } else {
        this.logger.log('No new listings — skipping Sheets/Discord');
      }
    } catch (err) {
      cycleError = err as Error;
      this.logger.error(`Cycle failed: ${cycleError.message}`, cycleError.stack);
    } finally {
      // Stats webhook fires UNCONDITIONALLY — empty cycle, full cycle, or
      // crashed cycle. The stats channel is the heartbeat.
      try {
        await this.discord.notifyCycleSummary(report, Date.now() - startedAt, cycleError);
      } catch (err) {
        this.logger.warn(`Stats notify failed: ${(err as Error).message}`);
      }
      this.logger.log(`Cycle finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      this.running = false;
    }
  }
}
