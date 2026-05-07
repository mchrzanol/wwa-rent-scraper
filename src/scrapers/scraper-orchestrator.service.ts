import { Inject, Injectable, Logger } from '@nestjs/common';
import { ListingStatus, Portal } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { PrismaService } from '../database/prisma.service';
import { RoutingService } from '../routing/routing.service';
import { GeocodingService } from '../routing/geocoding.service';
import { AiParserService } from '../ai/ai-parser.service';
import { DeduplicationService } from '../deduplication/deduplication.service';
import {
  NormalizedListing,
  RawListing,
} from '../common/types/listing.types';
import {
  PORTAL_SCRAPER,
  PortalScraper,
} from './portal-scraper.interface';

export interface OrchestratorReport {
  totals: { found: number; kept: number; duplicates: number; rejected: number };
  perPortal: Record<string, { found: number; kept: number; errors: number }>;
  rejectedByReason: Record<string, number>;
  newListingIds: string[];
}

export interface RunCycleOptions {
  /** Pages to walk per portal × district. Default 1 (first page only). */
  maxPages?: number;
}

/**
 * Single entry point for a scrape cycle. Pipeline per raw listing:
 *
 *   raw → coords (or geocode → discard if fails)
 *       → totalPrice (regex+AI fallback if adminFee missing)
 *       → strict price filter
 *       → routing (Haversine prefilter → ORS)
 *       → fingerprint + dedup
 *       → persist
 *
 * Returns IDs of newly inserted listings so the notifier (Discord/Sheets) can
 * push them downstream without coupling to this service.
 */
@Injectable()
export class ScraperOrchestratorService {
  private readonly logger = new Logger(ScraperOrchestratorService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PORTAL_SCRAPER) private readonly scrapers: PortalScraper[],
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly geocoding: GeocodingService,
    private readonly ai: AiParserService,
    private readonly dedup: DeduplicationService,
  ) {}

  async runCycle(opts: RunCycleOptions = {}): Promise<OrchestratorReport> {
    const maxPages = Math.max(1, opts.maxPages ?? 1);
    const report: OrchestratorReport = {
      totals: { found: 0, kept: 0, duplicates: 0, rejected: 0 },
      perPortal: {},
      rejectedByReason: {},
      newListingIds: [],
    };
    this.logger.log(`Cycle starting (maxPages=${maxPages})`);
    const rejectedDetails: Array<{ reason: string; url: string; portal: string }> = [];

    for (const scraper of this.scrapers) {
      const run = await this.prisma.scrapeRun.create({
        data: { portal: scraper.portal },
      });
      const portalReport = { found: 0, kept: 0, errors: 0 };
      const errors: Array<{ url?: string; message: string }> = [];

      try {
        const raws = await scraper.fetchListings({
          districts: this.config.filters.districts,
          rooms: this.config.filters.rooms,
          maxTotalPrice: this.config.filters.maxTotalPrice,
          maxBaseRent: this.config.filters.maxBaseRent,
          maxPages,
        });
        portalReport.found = raws.length;
        report.totals.found += raws.length;

        for (const raw of raws) {
          try {
            const outcome = await this.processOne(raw);
            switch (outcome.kind) {
              case 'kept':
                portalReport.kept += 1;
                report.totals.kept += 1;
                report.newListingIds.push(outcome.id);
                break;
              case 'duplicate':
                report.totals.duplicates += 1;
                break;
              case 'rejected':
                report.totals.rejected += 1;
                report.rejectedByReason[outcome.reason] =
                  (report.rejectedByReason[outcome.reason] ?? 0) + 1;
                rejectedDetails.push({ reason: outcome.reason, url: raw.url, portal: raw.portal });
                break;
            }
          } catch (err) {
            portalReport.errors += 1;
            errors.push({ url: raw.url, message: (err as Error).message });
            this.logger.warn(
              `Process failed for ${raw.url}: ${(err as Error).message}`,
            );
          }
        }
      } catch (err) {
        portalReport.errors += 1;
        errors.push({ message: (err as Error).message });
        this.logger.error(
          `Scraper ${scraper.portal} failed: ${(err as Error).message}`,
        );
      } finally {
        await this.prisma.scrapeRun.update({
          where: { id: run.id },
          data: {
            finishedAt: new Date(),
            itemsFound: portalReport.found,
            itemsKept: portalReport.kept,
            errors: errors.length ? errors : undefined,
          },
        });
        report.perPortal[scraper.portal] = portalReport;
      }
    }

    this.logger.log(
      `Cycle done — found ${report.totals.found}, kept ${report.totals.kept}, ` +
        `duplicates ${report.totals.duplicates}, rejected ${report.totals.rejected}`,
    );

    if (rejectedDetails.length) {
      const grouped = new Map<string, Array<{ url: string; portal: string }>>();
      for (const r of rejectedDetails) {
        if (!grouped.has(r.reason)) grouped.set(r.reason, []);
        grouped.get(r.reason)!.push({ url: r.url, portal: r.portal });
      }
      this.logger.log('=== REJECTED BREAKDOWN ===');
      for (const [reason, items] of grouped) {
        this.logger.log(`[${reason}] ${items.length} listing(s):`);
        for (const it of items) {
          this.logger.log(`    [${it.portal}] ${it.url}`);
        }
      }
      this.logger.log('==========================');
    }
    return report;
  }

  private async processOne(
    raw: RawListing,
  ): Promise<
    | { kind: 'kept'; id: string }
    | { kind: 'duplicate' }
    | { kind: 'rejected'; reason: string }
  > {
    const tag = `[${raw.portal}] ${raw.url}`;
    this.logger.log(
      `▶ ${tag} — rooms=${raw.rooms}, area=${raw.areaM2}m², rent=${raw.rentPrice}, admin=${raw.adminFee ?? '?'}`,
    );

    // 0. Already in DB? Same URL re-scraped on next cycle is not "new" and not
    //    a fingerprint duplicate — just skip.
    const existing = await this.prisma.listing.findUnique({
      where: { url: raw.url },
      select: { id: true },
    });
    if (existing) {
      this.logger.log(`  ↺ ${tag} already in DB (id=${existing.id}) — skipping`);
      return { kind: 'duplicate' };
    }

    // 1. Hard filters the portal might not have enforced
    if (raw.rooms !== this.config.filters.rooms) {
      this.logger.warn(`✗ ${tag} REJECT rooms_mismatch (got ${raw.rooms}, want ${this.config.filters.rooms})`);
      return { kind: 'rejected', reason: 'rooms_mismatch' };
    }

    // 2. Resolve adminFee + deposit + totalPrice (AI fallback when missing)
    let adminFee = raw.adminFee;
    let deposit = raw.deposit;
    let aiParsed: unknown;
    if ((adminFee == null || deposit == null) && raw.rawDescription) {
      this.logger.log(`  ↳ adminFee/deposit missing → calling AI cost extractor`);
      const costs = await this.ai.resolveCosts(raw.rawDescription);
      adminFee = adminFee ?? costs.adminFee;
      deposit = deposit ?? costs.deposit;
      aiParsed = costs;
      this.logger.log(`  ↳ AI returned adminFee=${adminFee ?? 'null'}, deposit=${deposit ?? 'null'} (confidence=${costs.confidence})`);
    }
    const totalPrice = raw.rentPrice + (adminFee ?? 0);
    if (totalPrice > this.config.filters.maxTotalPrice) {
      this.logger.warn(`✗ ${tag} REJECT total_price_exceeded (${totalPrice} > ${this.config.filters.maxTotalPrice})`);
      return { kind: 'rejected', reason: 'total_price_exceeded' };
    }
    this.logger.log(`  ✓ price OK (${totalPrice} ≤ ${this.config.filters.maxTotalPrice})`);

    // 3. Coordinates — scraper-provided wins; otherwise geocode at street level.
    let lat = raw.latitude;
    let lng = raw.longitude;
    let locationApproximate = false;
    if (lat == null || lng == null) {
      this.logger.log(`  ↳ coords missing → geocoding`);
      const hit = await this.resolveCoordinates(raw);
      if (!hit) {
        this.logger.warn(`✗ ${tag} REJECT unverifiable_location`);
        return { kind: 'rejected', reason: 'unverifiable_location' };
      }
      lat = hit.point.lat;
      lng = hit.point.lng;
      locationApproximate = hit.precision === 'area' || hit.precision === 'unknown' || hit.precision === 'place';
      this.logger.log(`  ↳ geocoded → ${lat.toFixed(5)},${lng.toFixed(5)} (${hit.precision}${locationApproximate ? ', APPROXIMATE' : ''})`);
    }

    // 4. Subway distance: Haversine prefilter → ORS
    const distance = await this.routing.resolveSubwayDistance({ lat, lng });
    if (!distance.withinWalkLimit) {
      this.logger.warn(
        `✗ ${tag} REJECT walk_distance_exceeded — nearest=${distance.station.name}, hav=${Math.round(distance.haversineMeters)}m, walk=${distance.walkingMeters ?? 'N/A'}m`,
      );
      return { kind: 'rejected', reason: 'walk_distance_exceeded' };
    }
    this.logger.log(
      `  ✓ walk OK — ${distance.station.name}: hav=${Math.round(distance.haversineMeters)}m, walk=${distance.walkingMeters}m`,
    );

    // 5. Build normalized listing + fingerprint
    const fingerprint = DeduplicationService.fingerprint({
      areaM2: raw.areaM2,
      totalPrice,
      district: raw.district,
      latitude: lat,
      longitude: lng,
    });
    const normalized: NormalizedListing = {
      ...raw,
      latitude: lat,
      longitude: lng,
      totalPrice,
      adminFee,
      deposit,
      nearestStation: distance.station.name,
      haversineMeters: distance.haversineMeters,
      walkingMeters: distance.walkingMeters,
      walkingApproximate: distance.walkingApproximate || locationApproximate,
      fingerprint,
    };

    // 6. Dedup
    const dup = await this.dedup.findDuplicate(normalized);
    if (dup.isDuplicate && dup.primary) {
      const inserted = await this.prisma.listing.create({
        data: this.toCreateInput(normalized, aiParsed, ListingStatus.STALE),
      });
      await this.dedup.linkDuplicate(
        dup.primary.id,
        inserted.id,
        dup.reason!,
        dup.matchScore ?? 1,
      );
      this.logger.log(`  ↺ ${tag} DUPLICATE of ${dup.primary.id} (${dup.reason})`);
      return { kind: 'duplicate' };
    }

    // 7. Persist as PUBLISHED — notifier will pick it up & flip notifiedAt
    const created = await this.prisma.listing.create({
      data: this.toCreateInput(normalized, aiParsed, ListingStatus.PUBLISHED),
    });
    this.logger.log(`  ★ ${tag} KEPT id=${created.id}`);
    return { kind: 'kept', id: created.id };
  }

  /**
   * Multi-stage geocoding. Each stage must produce at least `road`-level
   * precision; otherwise we move on. If every stage fails, the listing is
   * unverifiable and gets discarded.
   *
   * Stages, in order of cost:
   *   1. title (cheap; portals often put "ul. X 5" in the headline)
   *   2. address regex over rawDescription (free)
   *   3. address LLM over rawDescription (paid, fires last)
   */
  private async resolveCoordinates(raw: RawListing) {
    const tries: string[] = [];

    if (raw.title && /\b(ul\.?|ulica|al\.|aleja|plac|pl\.)\b/i.test(raw.title)) {
      tries.push(`${raw.title}, ${raw.district}`);
    }

    if (raw.rawDescription) {
      const extracted = await this.ai.resolveAddress(raw.rawDescription);
      if (extracted) {
        if (extracted.street) {
          const num = extracted.number ? ` ${extracted.number}` : '';
          tries.push(`ul. ${extracted.street}${num}, ${raw.district}`);
        }
        if (extracted.landmark) {
          tries.push(`${extracted.landmark}, Warszawa`);
        }
      }
    }

    // First pass: only accept precise matches (street level or better).
    let coarseHit: import('../routing/geocoding.service').GeocodeHit | null = null;
    for (const query of tries) {
      const hit = await this.geocoding.geocode(query);
      if (!hit) continue;
      if (hit.precision === 'area' || hit.precision === 'unknown') {
        coarseHit ??= hit; // keep the first coarse match in case nothing better turns up
        continue;
      }
      return hit;
    }

    // Fallback: district centroid via Nominatim (coarse, but better than dropping).
    if (!coarseHit) {
      const cityHit = await this.geocoding.geocode(`${raw.district}, Warszawa`);
      if (cityHit) coarseHit = cityHit;
    }

    if (coarseHit) {
      this.logger.warn(
        `Coarse location accepted for ${raw.url} → precision=${coarseHit.precision} (${coarseHit.displayName})`,
      );
    }
    return coarseHit;
  }

  private toCreateInput(
    n: NormalizedListing,
    aiParsed: unknown,
    status: ListingStatus,
  ) {
    return {
      portal: n.portal as Portal,
      externalId: n.externalId,
      url: n.url,
      title: n.title,
      district: n.district,
      rooms: n.rooms,
      areaM2: n.areaM2,
      rentPrice: n.rentPrice,
      adminFee: n.adminFee,
      deposit: n.deposit,
      totalPrice: n.totalPrice,
      phone: n.phone,
      postedAt: n.postedAt,
      latitude: n.latitude,
      longitude: n.longitude,
      nearestStation: n.nearestStation,
      haversineMeters: n.haversineMeters,
      walkingMeters: n.walkingMeters,
      walkingApproximate: n.walkingApproximate,
      fingerprint: n.fingerprint,
      status,
      rawDescription: n.rawDescription,
      aiParsed: aiParsed as object | undefined,
    };
  }
}
