import { ParkingType, Portal } from '@prisma/client';

/**
 * What a portal scraper produces. Coordinates may be missing — the
 * orchestrator will geocode/skip as needed.
 */
export interface RawListing {
  portal: Portal;
  externalId: string;
  url: string;

  title?: string;
  district: string;
  rooms: number;
  areaM2: number;

  rentPrice: number;
  adminFee?: number;
  deposit?: number;
  parking?: ParkingType;
  /** PLN/month. 0 means included in rent/admin. undefined means unknown. */
  parkingFee?: number;

  latitude?: number;
  longitude?: number;

  phone?: string;
  postedAt?: Date;
  rawDescription?: string;
}

export interface NormalizedListing extends RawListing {
  totalPrice: number;
  latitude: number;
  longitude: number;
  nearestStation: string;
  haversineMeters: number;
  walkingMeters?: number;
  walkingApproximate: boolean;
  fingerprint: string;
}
