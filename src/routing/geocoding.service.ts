import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { LatLng } from '../common/utils/haversine';

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  class?: string;
  type?: string;
  addresstype?: string;
  importance?: number;
}

export type GeocodePrecision =
  | 'house'        // exact street + number
  | 'road'         // street level, no number
  | 'place'        // POI / amenity / building
  | 'area'         // district / suburb / city — NOT precise enough for 1km walk filter
  | 'unknown';

export interface GeocodeHit {
  point: LatLng;
  precision: GeocodePrecision;
  displayName: string;
}

/**
 * Free-text → lat/lng via Nominatim. TOS-compliant: identifying UA, max
 * 1 req/s, in-memory cache. Returns precision so callers can reject
 * imprecise hits (e.g. district centroids).
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly cache = new Map<string, GeocodeHit | null>();
  private nextSlot = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async geocode(query: string): Promise<GeocodeHit | null> {
    const key = query.trim().toLowerCase();
    if (!key) return null;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;

    await this.throttle();

    const url = new URL('/search', this.config.nominatim.baseUrl);
    url.searchParams.set('q', `${query}, Warszawa, Polska`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');
    url.searchParams.set('countrycodes', 'pl');
    url.searchParams.set('addressdetails', '0');

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': this.config.nominatim.userAgent,
          'Accept-Language': 'pl',
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        this.logger.warn(`Nominatim HTTP ${res.status} for "${query}"`);
        this.cache.set(key, null);
        return null;
      }

      const data = (await res.json()) as NominatimResult[];
      const hit = data[0];
      if (!hit) {
        this.cache.set(key, null);
        return null;
      }

      const result: GeocodeHit = {
        point: { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) },
        precision: this.classifyPrecision(hit),
        displayName: hit.display_name,
      };
      this.cache.set(key, result);
      return result;
    } catch (err) {
      this.logger.warn(
        `Nominatim failed for "${query}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Classify Nominatim's response into precision tiers. We rely primarily on
   * `addresstype`, falling back to `class`/`type`. Anything coarser than a
   * road is treated as `area` and should be rejected by the orchestrator.
   */
  private classifyPrecision(hit: NominatimResult): GeocodePrecision {
    const t = (hit.addresstype ?? hit.type ?? '').toLowerCase();
    if (t === 'house' || t === 'house_number' || t === 'building') return 'house';
    if (t === 'road' || t === 'street' || hit.class === 'highway') return 'road';
    if (t === 'place' || t === 'amenity' || t === 'tourism' || t === 'shop')
      return 'place';
    if (
      t === 'suburb' ||
      t === 'city_district' ||
      t === 'neighbourhood' ||
      t === 'quarter' ||
      t === 'city' ||
      t === 'town' ||
      t === 'administrative'
    ) {
      return 'area';
    }
    return 'unknown';
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + 1_100;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}
