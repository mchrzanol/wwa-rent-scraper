import { Portal } from '@prisma/client';
import { RawListing } from '../common/types/listing.types';

export interface ScrapeContext {
  districts: string[];
  rooms: number;
  maxTotalPrice: number;
  /** Max base rent (excluding admin fee) used in portal-side URL filters. */
  maxBaseRent: number;
  /** Number of result pages to walk per district. 1 = first page only. */
  maxPages: number;
  /** AbortSignal for graceful cancellation from the orchestrator. */
  signal?: AbortSignal;
}

export interface PortalScraper {
  readonly portal: Portal;

  /**
   * Returns raw listings matching the coarse filters the portal can express
   * server-side (district, rooms, max price). Strict filtering happens later.
   */
  fetchListings(ctx: ScrapeContext): Promise<RawListing[]>;
}

export const PORTAL_SCRAPER = Symbol('PORTAL_SCRAPER');
