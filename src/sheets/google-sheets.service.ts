import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { google, sheets_v4 } from 'googleapis';
import { Listing } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { PrismaService } from '../database/prisma.service';

const HEADER = [
  'Created',
  'Portal',
  'District',
  'Rooms',
  'Area (m²)',
  'Rent',
  'Admin fee',
  'Total',
  'Deposit',
  'Walk (m)',
  'Walk approx?',
  'Nearest station',
  'Phone',
  'URL',
];

@Injectable()
export class GoogleSheetsService implements OnModuleInit {
  private readonly logger = new Logger(GoogleSheetsService.name);
  private sheets?: sheets_v4.Sheets;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.sheets.spreadsheetId || !this.config.sheets.serviceAccountJson) {
      this.logger.warn('Google Sheets not configured — sink disabled');
      return;
    }

    let credentials: Record<string, unknown>;
    try {
      credentials = this.loadServiceAccount(this.config.sheets.serviceAccountJson);
    } catch (err) {
      this.logger.error(
        `GOOGLE_SA_JSON could not be loaded: ${(err as Error).message}`,
      );
      return;
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    this.sheets = google.sheets({ version: 'v4', auth: await auth.getClient() as any });

    await this.ensureHeader();
  }

  /**
   * Append one row per listing. Uses a single batched call to minimize quota
   * usage. Order of `listingIds` is preserved.
   */
  async appendListings(listingIds: string[]): Promise<void> {
    if (!this.sheets || !listingIds.length) return;

    const listings = await this.prisma.listing.findMany({
      where: { id: { in: listingIds } },
    });
    // Preserve caller's order
    const byId = new Map(listings.map((l) => [l.id, l]));
    const ordered = listingIds.map((id) => byId.get(id)).filter(Boolean) as Listing[];
    if (!ordered.length) return;

    const values = ordered.map((l) => this.toRow(l));

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${this.config.sheets.sheetName}!A:N`,
        valueInputOption: 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values },
      });
      this.logger.log(`Appended ${values.length} rows to Sheets`);
    } catch (err) {
      this.logger.error(`Sheets append failed: ${(err as Error).message}`);
    }
  }

  /**
   * Walks every row in the sheet, HEAD-checks each URL, and removes rows
   * pointing to dead listings (404, 410, redirect away from the original URL).
   * Listings are also flagged STALE in the DB so they don't get re-promoted.
   *
   * Returns the count of rows removed.
   */
  async cleanupDeadListings(): Promise<{ checked: number; removed: number }> {
    if (!this.sheets) return { checked: 0, removed: 0 };

    const sheetName = this.config.sheets.sheetName;
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.config.sheets.spreadsheetId,
    });
    const sheetId = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === sheetName,
    )?.properties?.sheetId;
    if (sheetId == null) return { checked: 0, removed: 0 };

    // URL is column N (14th). Pull the entire column starting from row 2 to
    // skip the header. Empty trailing rows are filtered by the API.
    const resp = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.config.sheets.spreadsheetId,
      range: `${sheetName}!N2:N`,
    });
    const urls = (resp.data.values ?? []).map((row) => (row[0] as string) ?? '');
    if (!urls.length) return { checked: 0, removed: 0 };

    const deadIndices: number[] = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].trim();
      if (!url) continue;
      const dead = await this.isListingDead(url);
      if (dead) deadIndices.push(i);
      // Pace requests so portals don't rate-limit / block us.
      await new Promise((r) => setTimeout(r, 250));
    }

    if (deadIndices.length === 0) {
      this.logger.log(`Cleanup: ${urls.length} listings checked, all alive`);
      return { checked: urls.length, removed: 0 };
    }

    // Mark dead URLs as STALE in the DB.
    const deadUrls = deadIndices.map((i) => urls[i]);
    try {
      const updated = await this.prisma.listing.updateMany({
        where: { url: { in: deadUrls } },
        data: { status: 'STALE' },
      });
      this.logger.log(`Cleanup: marked ${updated.count} listing(s) as STALE in DB`);
    } catch (err) {
      this.logger.warn(`Cleanup DB update failed: ${(err as Error).message}`);
    }

    // Delete rows bottom-up so earlier indices stay valid. Sheet rows are
    // 0-indexed; the URL column starts at row 2 (index 1) because of the header.
    const sortedDesc = [...deadIndices].sort((a, b) => b - a);
    const requests = sortedDesc.map((i) => ({
      deleteDimension: {
        range: {
          sheetId,
          dimension: 'ROWS' as const,
          startIndex: i + 1, // +1 for header row
          endIndex: i + 2,
        },
      },
    }));
    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.config.sheets.spreadsheetId,
      requestBody: { requests },
    });

    this.logger.log(
      `Cleanup: ${urls.length} listings checked, ${deadIndices.length} removed`,
    );
    return { checked: urls.length, removed: deadIndices.length };
  }

  /**
   * Single URL liveness check. We treat as dead:
   *   - HTTP 404, 410, 451
   *   - HTTP 5xx persistently (one shot — don't false-positive on transient)
   *   - 2xx but final URL no longer points at a listing detail page
   *     (portals redirect expired ads to the search/home page).
   * On network errors we KEEP the listing — better a stale row than mass
   * deletion if the network blips.
   */
  private async isListingDead(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        signal: AbortSignal.timeout(8_000),
        headers: {
          'User-Agent': 'Mozilla/5.0 (rent-scraper liveness check)',
          Accept: 'text/html',
        },
      });

      if (res.status === 404 || res.status === 410 || res.status === 451) {
        return true;
      }

      // Some portals reject HEAD; retry GET if status is 405 / 403.
      if (res.status === 405 || res.status === 403) {
        const get = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(8_000),
          headers: { 'User-Agent': 'Mozilla/5.0 (rent-scraper liveness check)' },
        });
        if (get.status === 404 || get.status === 410 || get.status === 451) return true;
        if (this.isRedirectedAway(url, get.url)) return true;
        return false;
      }

      if (this.isRedirectedAway(url, res.url)) return true;

      return false;
    } catch (err) {
      // Network/timeout errors → keep, don't risk false-positives.
      this.logger.warn(`Liveness check failed for ${url}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Heuristic: a redirect is considered "away" when the final URL no longer
   * contains the original ad's slug or ID. Listing URLs typically have a
   * portal-specific ID; if that's gone, the ad is dead.
   */
  private isRedirectedAway(originalUrl: string, finalUrl: string): boolean {
    if (!finalUrl || originalUrl === finalUrl) return false;
    // Compare path heads. If the original had `/oferta/`, `/d/oferta/` or
    // `/do-wynajecia/` and final no longer does → away.
    const origIsListing = /\/(?:oferta|d\/oferta|do-wynajecia)\//.test(originalUrl);
    const finalIsListing = /\/(?:oferta|d\/oferta|do-wynajecia)\//.test(finalUrl);
    return origIsListing && !finalIsListing;
  }

  /**
   * Accepts either an inline JSON blob or a filesystem path to a service-account
   * JSON file. Path is detected when the value does not start with `{`.
   * Relative paths are resolved against process.cwd().
   */
  private loadServiceAccount(value: string): Record<string, unknown> {
    const trimmed = value.trim();
    const raw = trimmed.startsWith('{')
      ? trimmed
      : readFileSync(isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed), 'utf8');
    return JSON.parse(raw);
  }

  private toRow(l: Listing): Array<string | number | boolean> {
    return [
      l.createdAt.toISOString(),
      l.portal,
      l.district,
      l.rooms,
      l.areaM2,
      l.rentPrice,
      l.adminFee ?? '',
      l.totalPrice,
      l.deposit ?? '',
      l.walkingMeters ?? l.haversineMeters,
      l.walkingApproximate,
      l.nearestStation,
      l.phone ?? '',
      l.url,
    ];
  }

  /**
   * Idempotent: ensures a tab named this.config.sheets.sheetName exists (creates if missing) and
   * writes the header row only if A1 is empty.
   */
  private async ensureHeader(): Promise<void> {
    if (!this.sheets) return;
    try {
      const meta = await this.sheets.spreadsheets.get({
        spreadsheetId: this.config.sheets.spreadsheetId,
      });
      const existing = (meta.data.sheets ?? []).some(
        (s) => s.properties?.title === this.config.sheets.sheetName,
      );

      if (!existing) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.config.sheets.spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: this.config.sheets.sheetName } } }],
          },
        });
        this.logger.log(`Created Sheets tab "${this.config.sheets.sheetName}"`);
      }

      const probe = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${this.config.sheets.sheetName}!A1`,
      });
      if (probe.data.values?.[0]?.[0]) return;

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${this.config.sheets.sheetName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      });
      this.logger.log('Wrote Sheets header row');

      await this.applyHeaderFormatting();
    } catch (err) {
      this.logger.warn(`ensureHeader skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Bolds the header row, freezes it, applies a banded background, and adds
   * a basic filter — turns the raw values into a real "table" view.
   */
  private async applyHeaderFormatting(): Promise<void> {
    if (!this.sheets) return;
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.config.sheets.spreadsheetId,
    });
    const sheetId = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === this.config.sheets.sheetName,
    )?.properties?.sheetId;
    if (sheetId == null) return;

    await this.sheets.spreadsheets.batchUpdate({
      spreadsheetId: this.config.sheets.spreadsheetId,
      requestBody: {
        requests: [
          // Freeze header row
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          // Bold + grey background on header
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.92, green: 0.92, blue: 0.95 },
                  horizontalAlignment: 'CENTER',
                },
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor,horizontalAlignment)',
            },
          },
          // Auto-filter over all columns
          {
            setBasicFilter: {
              filter: {
                range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: HEADER.length },
              },
            },
          },
          // Auto-resize all columns to fit
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: HEADER.length,
              },
            },
          },
        ],
      },
    });
    this.logger.log('Applied Sheets header formatting (frozen, bold, filtered)');
  }
}
