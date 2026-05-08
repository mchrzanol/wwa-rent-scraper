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
  'Score',
  'Status',
] as const;

const STATUS_VALUES = ['new', 'shortlist', 'contacted', 'viewed', 'rejected'] as const;
const STATUS_DEFAULT: typeof STATUS_VALUES[number] = 'new';

const STATUS_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  shortlist: { red: 1.0, green: 0.95, blue: 0.7 },   // light yellow
  contacted: { red: 0.78, green: 0.87, blue: 0.97 }, // light blue
  viewed:    { red: 0.86, green: 0.82, blue: 0.94 }, // light purple
  rejected:  { red: 0.96, green: 0.80, blue: 0.80 }, // light red
};

const COL = {
  Score: HEADER.indexOf('Score'),
  Status: HEADER.indexOf('Status'),
} as const;

const RANGE_A_TO_LAST = `A:${columnLetter(HEADER.length)}`;

function columnLetter(n: number): string {
  // 1-indexed: 1→A, 26→Z, 27→AA. HEADER.length is 16 → 'P'.
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

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
    await this.applySheetFormatting();
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
    const byId = new Map(listings.map((l) => [l.id, l]));
    const ordered = listingIds.map((id) => byId.get(id)).filter(Boolean) as Listing[];
    if (!ordered.length) return;

    const values = ordered.map((l) => this.toRow(l));

    try {
      await this.sheets.spreadsheets.values.append({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${this.config.sheets.sheetName}!${RANGE_A_TO_LAST}`,
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
   * Wipes all data rows (keeping header + tab) and re-emits every Listing in
   * the DB with the current schema (Score/Status etc.). Use after the row
   * shape changes or when you want the sheet rebuilt from scratch.
   *
   * Caveat: this clobbers any manual Status edits in the sheet — Status is
   * sheet-only state, not persisted to DB.
   */
  async resyncAllListings(): Promise<{ written: number }> {
    if (!this.sheets) {
      throw new Error('Sheets not configured');
    }

    const all = await this.prisma.listing.findMany({
      orderBy: { createdAt: 'desc' },
    });
    this.logger.warn(
      `Resync: wiping sheet "${this.config.sheets.sheetName}" and writing ${all.length} rows from DB. ` +
        `Any manual Status edits in the sheet will be lost.`,
    );

    // Clear data rows (everything below header).
    await this.sheets.spreadsheets.values.clear({
      spreadsheetId: this.config.sheets.spreadsheetId,
      range: `${this.config.sheets.sheetName}!${columnLetter(1)}2:${columnLetter(HEADER.length)}`,
    });

    if (all.length) {
      const values = all.map((l) => this.toRow(l));
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.config.sheets.spreadsheetId,
        range: `${this.config.sheets.sheetName}!A2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values },
      });
    }

    // Re-apply formatting (filter range, validation, conditional rules).
    await this.applySheetFormatting();
    this.logger.log(`Resync done: ${all.length} rows written`);
    return { written: all.length };
  }

  private loadServiceAccount(value: string): Record<string, unknown> {
    const trimmed = value.trim();
    const raw = trimmed.startsWith('{')
      ? trimmed
      : readFileSync(isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed), 'utf8');
    return JSON.parse(raw);
  }

  /**
   * Score: higher = better deal. Combines price-per-m² and walking distance
   * (both lower-is-better). Tunable formula — tweak as priorities shift.
   */
  private computeScore(l: Listing): number {
    const pricePerM2 = l.totalPrice / l.areaM2;
    const walk = l.walkingMeters ?? l.haversineMeters;
    return Math.round(200 - pricePerM2 - walk / 100);
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
      this.computeScore(l),
      STATUS_DEFAULT,
    ];
  }

  /**
   * Idempotent: ensures the tab exists, writes the header row if missing, and
   * upgrades an outdated header in-place (so callers don't have to wipe the
   * sheet when columns are added).
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
        range: `${this.config.sheets.sheetName}!1:1`,
      });
      const currentHeader = (probe.data.values?.[0] ?? []) as string[];
      const matches =
        currentHeader.length === HEADER.length &&
        HEADER.every((h, i) => currentHeader[i] === h);

      if (!matches) {
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.config.sheets.spreadsheetId,
          range: `${this.config.sheets.sheetName}!A1:${columnLetter(HEADER.length)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [[...HEADER]] },
        });
        this.logger.log(
          currentHeader.length
            ? `Upgraded Sheets header (was ${currentHeader.length} cols, now ${HEADER.length})`
            : 'Wrote Sheets header row',
        );
      }
    } catch (err) {
      this.logger.warn(`ensureHeader skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Idempotent: header bold/freeze/filter, Status dropdown, conditional
   * formatting per Status value. Safe to re-run on every boot.
   */
  private async applySheetFormatting(): Promise<void> {
    if (!this.sheets) return;
    try {
      const meta = await this.sheets.spreadsheets.get({
        spreadsheetId: this.config.sheets.spreadsheetId,
      });
      const sheet = (meta.data.sheets ?? []).find(
        (s) => s.properties?.title === this.config.sheets.sheetName,
      );
      const sheetId = sheet?.properties?.sheetId;
      if (sheetId == null) return;

      const requests: sheets_v4.Schema$Request[] = [
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: 'gridProperties.frozenRowCount',
          },
        },
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
        {
          setBasicFilter: {
            filter: {
              range: {
                sheetId,
                startRowIndex: 0,
                startColumnIndex: 0,
                endColumnIndex: HEADER.length,
              },
            },
          },
        },
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
        // Data validation dropdown on Status column (rows 2..end).
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              startColumnIndex: COL.Status,
              endColumnIndex: COL.Status + 1,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: STATUS_VALUES.map((v) => ({ userEnteredValue: v })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ];

      // Conditional formatting per status value (skip 'new' = no color).
      for (const status of STATUS_VALUES) {
        if (status === 'new') continue;
        requests.push({
          addConditionalFormatRule: {
            rule: {
              ranges: [
                {
                  sheetId,
                  startRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: HEADER.length,
                },
              ],
              booleanRule: {
                condition: {
                  type: 'CUSTOM_FORMULA',
                  values: [
                    {
                      userEnteredValue: `=$${columnLetter(COL.Status + 1)}2="${status}"`,
                    },
                  ],
                },
                format: { backgroundColor: STATUS_COLORS[status] },
              },
            },
            index: 0,
          },
        });
      }

      // Conditional gradient on Score column: red (low) → green (high).
      requests.push({
        addConditionalFormatRule: {
          rule: {
            ranges: [
              {
                sheetId,
                startRowIndex: 1,
                startColumnIndex: COL.Score,
                endColumnIndex: COL.Score + 1,
              },
            ],
            gradientRule: {
              minpoint: {
                type: 'MIN',
                color: { red: 0.96, green: 0.80, blue: 0.80 },
              },
              midpoint: {
                type: 'PERCENTILE',
                value: '50',
                color: { red: 1, green: 1, blue: 0.85 },
              },
              maxpoint: {
                type: 'MAX',
                color: { red: 0.72, green: 0.88, blue: 0.74 },
              },
            },
          },
          index: 0,
        },
      });

      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.config.sheets.spreadsheetId,
        requestBody: { requests },
      });
      this.logger.log('Applied Sheets formatting (header, validation, conditional rules)');
    } catch (err) {
      this.logger.warn(`applySheetFormatting skipped: ${(err as Error).message}`);
    }
  }
}
