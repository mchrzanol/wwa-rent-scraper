import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { haversineMeters, LatLng } from '../common/utils/haversine';
import {
  SubwayStation,
  WARSAW_SUBWAY_STATIONS,
} from '../config/subway-stations';

export interface NearestStationResult {
  station: SubwayStation;
  haversineMeters: number;
}

export interface SubwayDistance {
  station: SubwayStation;
  haversineMeters: number;
  /** Resolved walking distance — ORS, then OSRM, then haversine fallback. */
  walkingMeters?: number;
  /** True when walkingMeters is the straight-line fallback (both routers failed). */
  walkingApproximate: boolean;
  /** True iff listing should be kept under the user's filters. */
  withinWalkLimit: boolean;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  private readonly stations: SubwayStation[] = WARSAW_SUBWAY_STATIONS;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  findNearestStation(point: LatLng): NearestStationResult {
    let best: NearestStationResult | null = null;
    for (const station of this.stations) {
      const d = haversineMeters(point, { lat: station.lat, lng: station.lng });
      if (!best || d < best.haversineMeters) {
        best = { station, haversineMeters: d };
      }
    }
    if (!best) throw new Error('No subway stations configured');
    return best;
  }

  /**
   * Two-phase distance check.
   *
   *  1. Haversine prefilter: if straight-line > 1.2km we discard immediately
   *     and skip the ORS call (saves daily API quota).
   *  2. ORS foot-walking: get the actual walking route distance. Keep listing
   *     only if walking distance ≤ 1km.
   *
   * If ORS fails, we fall back to "rejected" — better to drop a borderline
   * candidate than spam Discord with bad data.
   */
  async resolveSubwayDistance(point: LatLng): Promise<SubwayDistance> {
    const { station, haversineMeters: hav } = this.findNearestStation(point);
    const { haversinePrefilterMeters, maxWalkingMeters } = this.config.filters;

    if (hav > haversinePrefilterMeters) {
      this.logger.log(
        `Haversine prefilter: ${station.name} ${Math.round(hav)}m > ${haversinePrefilterMeters}m → skip ORS`,
      );
      return {
        station,
        haversineMeters: hav,
        walkingApproximate: false,
        withinWalkLimit: false,
      };
    }

    this.logger.log(
      `→ ORS call for ${station.name} (haversine=${Math.round(hav)}m)`,
    );
    let walking: number | undefined;
    let approximate = false;
    try {
      walking = await this.fetchWalkingDistance(point, station);
      this.logger.log(`← ORS returned ${walking}m walk to ${station.name}`);
    } catch (err) {
      this.logger.warn(
        `ORS failed for ${station.name}: ${(err as Error).message} — trying OSRM fallback`,
      );
      try {
        walking = await this.fetchWalkingDistanceOsrm(point, station);
        this.logger.log(`← OSRM returned ${walking}m walk to ${station.name}`);
      } catch (osrmErr) {
        // Last resort: haversine straight-line distance, marked as approximate.
        // Real walks are usually 1.2-1.4× straight-line in Warsaw, so this is
        // optimistic — the listing might fail to actually walk under the
        // limit. We still keep it but flag it for the user.
        walking = Math.round(hav);
        approximate = true;
        this.logger.warn(
          `OSRM fallback failed for ${station.name}: ${(osrmErr as Error).message} — using haversine ${walking}m as APPROXIMATE walking distance`,
        );
      }
    }

    return {
      station,
      haversineMeters: hav,
      walkingMeters: walking,
      walkingApproximate: approximate,
      withinWalkLimit: walking <= maxWalkingMeters,
    };
  }

  // ORS free tier: 40 req/min for Directions V2. We cap at 35/min (≈1714ms
  // gap) to leave headroom for clock skew and bursts.
  private static readonly MIN_GAP_MS = 1714;
  private static readonly RATE_LIMIT_BACKOFFS_MS = [5000, 15000, 30000];
  private lastCallAt = 0;
  private orsQueue: Promise<unknown> = Promise.resolve();

  /** Serializes ORS calls and enforces MIN_GAP_MS between them. */
  private async throttleOrs(): Promise<void> {
    const wait = this.orsQueue.then(async () => {
      const now = Date.now();
      const gap = now - this.lastCallAt;
      if (gap < RoutingService.MIN_GAP_MS) {
        await new Promise((r) => setTimeout(r, RoutingService.MIN_GAP_MS - gap));
      }
      this.lastCallAt = Date.now();
    });
    this.orsQueue = wait.catch(() => undefined);
    await wait;
  }

  private async fetchWalkingDistance(
    from: LatLng,
    station: SubwayStation,
  ): Promise<number> {
    const { apiKey, baseUrl } = this.config.ors;
    if (!apiKey) throw new Error('ORS_API_KEY not set');

    const body = {
      coordinates: [
        [from.lng, from.lat],
        [station.lng, station.lat],
      ],
      units: 'm',
      instructions: false,
    };

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= RoutingService.RATE_LIMIT_BACKOFFS_MS.length; attempt++) {
      await this.throttleOrs();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(baseUrl, {
          method: 'POST',
          headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (res.status === 429) {
          const wait = RoutingService.RATE_LIMIT_BACKOFFS_MS[attempt];
          if (wait == null) {
            throw new Error(`ORS HTTP 429 after ${attempt} retries — giving up`);
          }
          this.logger.warn(`ORS 429 — backoff ${wait}ms (attempt ${attempt + 1}/${RoutingService.RATE_LIMIT_BACKOFFS_MS.length})`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }

        if (!res.ok) {
          throw new Error(`ORS HTTP ${res.status}: ${await res.text()}`);
        }

        const json = (await res.json()) as {
          routes?: Array<{ summary?: { distance?: number } }>;
        };
        const distance = json.routes?.[0]?.summary?.distance;
        if (typeof distance !== 'number') {
          throw new Error('ORS response missing summary.distance');
        }
        return Math.round(distance);
      } catch (err) {
        lastError = err as Error;
        // Network error or timeout — only retry on 429 path; otherwise bail.
        if (!String(lastError.message).includes('429')) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error('ORS exhausted retries');
  }

  /**
   * Public OSRM demo server (router.project-osrm.org) — no API key, no quota,
   * but rate-limited per IP. Used as fallback when ORS gives up on 429.
   */
  private async fetchWalkingDistanceOsrm(
    from: LatLng,
    station: SubwayStation,
  ): Promise<number> {
    const url =
      `https://router.project-osrm.org/route/v1/foot/` +
      `${from.lng},${from.lat};${station.lng},${station.lat}` +
      `?overview=false&alternatives=false&steps=false`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`OSRM HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        routes?: Array<{ distance?: number }>;
      };
      const distance = json.routes?.[0]?.distance;
      if (typeof distance !== 'number') {
        throw new Error('OSRM response missing routes[0].distance');
      }
      return Math.round(distance);
    } finally {
      clearTimeout(timeout);
    }
  }
}
