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

const SHEET_NAME = 'Listings';
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
        range: `${SHEET_NAME}!A:M`,
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

  private toRow(l: Listing): Array<string | number> {
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
      l.walkingApproximate
        ? `~${l.walkingMeters ?? l.haversineMeters} (approx)`
        : (l.walkingMeters ?? l.haversineMeters),
      l.nearestStation,
      l.phone ?? '',
      l.url,
    ];
  }

  /**
   * Idempotent: ensures a tab named SHEET_NAME exists (creates if missing) and
   * writes the header row only if A1 is empty.
   */
  private async ensureHeader(): Promise<void> {
    if (!this.sheets) return;
    try {
      const meta = await this.sheets.spreadsheets.get({
        spreadsheetId: this.config.sheets.spreadsheetId,
      });
      const existing = (meta.data.sheets ?? []).some(
        (s) => s.properties?.title === SHEET_NAME,
      );

      if (!existing) {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: this.config.sheets.spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: SHEET_NAME } } }],
          },
        });
        this.logger.log(`Created Sheets tab "${SHEET_NAME}"`);
      }

      const probe = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${SHEET_NAME}!A1`,
      });
      if (probe.data.values?.[0]?.[0]) return;

      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${SHEET_NAME}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [HEADER] },
      });
      this.logger.log('Wrote Sheets header row');
    } catch (err) {
      this.logger.warn(`ensureHeader skipped: ${(err as Error).message}`);
    }
  }
}
