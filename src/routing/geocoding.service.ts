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

    // Try Nominatim first (authoritative). If it returns null or area-level
    // hit, retry with Mapy.cz Geocoding API — Nominatim is strict on Polish
    // inflections; Mapy.cz handles them well and tolerates loose formatting.
    const primary = await this.geocodeNominatim(query);
    if (primary && primary.precision !== 'area' && primary.precision !== 'unknown') {
      this.cache.set(key, primary);
      return primary;
    }

    const fallback = await this.geocodeMapy(query);
    if (fallback && fallback.precision !== 'area' && fallback.precision !== 'unknown') {
      this.cache.set(key, fallback);
      return fallback;
    }

    // Neither precise — return whichever non-null result we got, prefer Mapy
    // (richer fuzzy match, more likely to land in the right ballpark).
    const result = fallback ?? primary ?? null;
    this.cache.set(key, result);
    return result;
  }

  private async geocodeNominatim(query: string): Promise<GeocodeHit | null> {
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
        return null;
      }

      const data = (await res.json()) as NominatimResult[];
      const hit = data[0];
      if (!hit) return null;

      return {
        point: { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) },
        precision: this.classifyPrecision(hit),
        displayName: hit.display_name,
      };
    } catch (err) {
      this.logger.warn(
        `Nominatim failed for "${query}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Mapy.cz Geocoding API (api.mapy.cz/v1/geocode). Free tier: ~250k requests
   * per month. Polish coverage is solid and the matcher is much more forgiving
   * than Nominatim for inflected/abbreviated address forms. Used as fallback
   * when Nominatim returns null or area-level only. No-op if MAPY_API_KEY
   * is not set.
   */
  private async geocodeMapy(query: string): Promise<GeocodeHit | null> {
    const apiKey = this.config.mapy.apiKey;
    if (!apiKey) return null;

    // Mapy.cz with type=regional.street works best with: bare street name +
    // city only (no district, no "ul." prefix, no house number). Empirical:
    // adding the house number drops the hit rate; the resulting street-level
    // coordinate is plenty precise for our walking-distance filter.
    const cleaned = query
      .replace(/\b(ul\.?|ulica|al\.?|aleja|plac|pl\.?)\s+/gi, '')
      // Drop the trailing ", <district/city>" token added by orchestrator.
      .replace(/,\s*[^,]+$/i, '')
      // Drop trailing house number ("Czarnomorska 17" → "Czarnomorska").
      .replace(/\s+\d+[A-Za-z]?\s*$/i, '')
      .trim();
    const finalQuery = `${cleaned}, Warszawa`;

    const url = new URL('https://api.mapy.cz/v1/geocode');
    url.searchParams.set('query', finalQuery);
    url.searchParams.set('lang', 'pl');
    url.searchParams.set('limit', '1');
    // Restrict to street-level matches — best precision for our use case.
    url.searchParams.set('type', 'regional.street');

    try {
      const res = await fetch(url, {
        headers: {
          'Accept-Language': 'pl',
          'X-Mapy-Api-Key': apiKey,
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        this.logger.warn(`Mapy.cz HTTP ${res.status} for "${finalQuery}"`);
        return null;
      }

      const data = (await res.json()) as {
        items?: Array<{
          name?: string;
          label?: string;
          position?: { lat?: number; lon?: number };
          type?: string;
        }>;
      };
      const f = data.items?.[0];
      const lat = f?.position?.lat;
      const lon = f?.position?.lon;
      if (!f || typeof lat !== 'number' || typeof lon !== 'number') return null;

      const precision = this.classifyMapy(f.type ?? '');
      const displayName = f.label ?? f.name ?? '';

      this.logger.log(
        `Mapy.cz: "${finalQuery}" → ${precision} (${displayName})`,
      );

      return {
        point: { lat, lng: lon },
        precision,
        displayName,
      };
    } catch (err) {
      this.logger.warn(`Mapy.cz failed for "${query}": ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Map Mapy.cz "type" string to our precision tiers. Their docs use values
   * like "regional.address" (house+street), "regional.street", "regional.city",
   * "poi", etc.
   */
  private classifyMapy(type: string): GeocodePrecision {
    const t = type.toLowerCase();
    if (t.includes('address')) return 'house';
    if (t.includes('street')) return 'road';
    if (t === 'poi' || t.includes('amenity') || t.includes('shop')) return 'place';
    if (t.includes('city') || t.includes('district') || t.includes('suburb') || t.includes('region')) return 'area';
    return 'unknown';
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
