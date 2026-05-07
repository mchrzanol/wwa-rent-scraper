import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { AiModule } from '../ai/ai.module';
import { DeduplicationModule } from '../deduplication/deduplication.module';
import { PORTAL_SCRAPER } from './portal-scraper.interface';
import { OtodomScraper } from './otodom/otodom.scraper';
import { OlxScraper } from './olx/olx.scraper';
import { ScraperOrchestratorService } from './scraper-orchestrator.service';

@Module({
  imports: [RoutingModule, AiModule, DeduplicationModule],
  providers: [
    OtodomScraper,
    OlxScraper,
    {
      provide: PORTAL_SCRAPER,
      useFactory: (otodom: OtodomScraper, olx: OlxScraper) => [otodom, olx],
      inject: [OtodomScraper, OlxScraper],
    },
    ScraperOrchestratorService,
  ],
  exports: [ScraperOrchestratorService],
})
export class ScrapersModule {}
