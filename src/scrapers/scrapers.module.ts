import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { AiModule } from '../ai/ai.module';
import { DeduplicationModule } from '../deduplication/deduplication.module';
import { PORTAL_SCRAPER } from './portal-scraper.interface';
import { OtodomScraper } from './otodom/otodom.scraper';
import { OlxScraper } from './olx/olx.scraper';
import { MorizonScraper } from './morizon/morizon.scraper';
import { ScraperOrchestratorService } from './scraper-orchestrator.service';

@Module({
  imports: [RoutingModule, AiModule, DeduplicationModule],
  providers: [
    OtodomScraper,
    OlxScraper,
    MorizonScraper,
    {
      provide: PORTAL_SCRAPER,
      useFactory: (
        otodom: OtodomScraper,
        olx: OlxScraper,
        morizon: MorizonScraper,
      ) => [otodom, olx, morizon],
      inject: [OtodomScraper, OlxScraper, MorizonScraper],
    },
    ScraperOrchestratorService,
  ],
  exports: [ScraperOrchestratorService],
})
export class ScrapersModule {}
