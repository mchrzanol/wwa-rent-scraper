import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Listing } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NormalizedListing } from '../common/types/listing.types';
import { haversineMeters } from '../common/utils/haversine';

export interface DedupResult {
  isDuplicate: boolean;
  primary?: Listing;
  reason?: 'exact_fingerprint' | 'fuzzy_geo_price';
  matchScore?: number;
}

/**
 * Two-tier dedup:
 *   1. Fingerprint hash (cheap, indexed) — catches the obvious cross-portal
 *      reposts where area/price/district/coords all line up.
 *   2. Fuzzy fallback within the same district — catches rounding & coord
 *      drift between portals (e.g. Otodom precise lat/lng vs OLX geocoded).
 *
 * If isDuplicate is true and `primary` is set, persist a DuplicateLink.
 */
@Injectable()
export class DeduplicationService {
  private readonly logger = new Logger(DeduplicationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Pure function: stable fingerprint for a normalized listing. */
  static fingerprint(input: {
    areaM2: number;
    totalPrice: number;
    district: string;
    latitude: number;
    longitude: number;
  }): string {
    const parts = [
      Math.round(input.areaM2),
      input.totalPrice,
      input.district.toLowerCase().trim(),
      input.latitude.toFixed(3),
      input.longitude.toFixed(3),
    ].join('|');
    return createHash('sha1').update(parts).digest('hex');
  }

  async findDuplicate(candidate: NormalizedListing): Promise<DedupResult> {
    // Tier 1: same portal+externalId is a hard duplicate (re-scrape of same ad)
    const sameAd = await this.prisma.listing.findUnique({
      where: {
        portal_externalId: {
          portal: candidate.portal,
          externalId: candidate.externalId,
        },
      },
    });
    if (sameAd) {
      return {
        isDuplicate: true,
        primary: sameAd,
        reason: 'exact_fingerprint',
        matchScore: 1,
      };
    }

    // Tier 2: fingerprint match across portals
    const exact = await this.prisma.listing.findFirst({
      where: { fingerprint: candidate.fingerprint },
      orderBy: { createdAt: 'asc' },
    });
    if (exact) {
      return {
        isDuplicate: true,
        primary: exact,
        reason: 'exact_fingerprint',
        matchScore: 1,
      };
    }

    // Tier 3: fuzzy match — same district, area within ±1 m², price within
    // ±100 PLN, geographic distance ≤ 80 m.
    const candidates = await this.prisma.listing.findMany({
      where: {
        district: candidate.district,
        areaM2: { gte: candidate.areaM2 - 1, lte: candidate.areaM2 + 1 },
        totalPrice: {
          gte: candidate.totalPrice - 100,
          lte: candidate.totalPrice + 100,
        },
      },
      take: 25,
      orderBy: { createdAt: 'desc' },
    });

    for (const existing of candidates) {
      const dist = haversineMeters(
        { lat: candidate.latitude, lng: candidate.longitude },
        { lat: existing.latitude, lng: existing.longitude },
      );
      if (dist <= 80) {
        return {
          isDuplicate: true,
          primary: existing,
          reason: 'fuzzy_geo_price',
          matchScore: Number((1 - dist / 80).toFixed(3)),
        };
      }
    }

    return { isDuplicate: false };
  }

  async linkDuplicate(
    primaryId: string,
    duplicateId: string,
    reason: 'exact_fingerprint' | 'fuzzy_geo_price',
    matchScore: number,
  ): Promise<void> {
    await this.prisma.duplicateLink
      .create({
        data: { primaryId, duplicateId, reason, matchScore },
      })
      .catch((err) => {
        // unique violation = already linked, that's fine
        this.logger.debug(`linkDuplicate ignored: ${(err as Error).message}`);
      });
  }
}
