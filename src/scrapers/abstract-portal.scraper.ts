import { Logger } from '@nestjs/common';
import { Portal } from '@prisma/client';
import { Page } from 'playwright';
import { PlaywrightService } from '../playwright/playwright.service';
import { RawListing } from '../common/types/listing.types';
import { PortalScraper, ScrapeContext } from './portal-scraper.interface';

export abstract class AbstractPortalScraper implements PortalScraper {
  abstract readonly portal: Portal;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly playwright: PlaywrightService) {}

  abstract fetchListings(ctx: ScrapeContext): Promise<RawListing[]>;

  /**
   * Convenience helper: spin up a stealth page, run the scrape callback,
   * and always close the context.
   */
  protected async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const session = await this.playwright.newStealthPage();
    try {
      const result = await fn(session.page);
      this.playwright.reportProxySuccess(session.proxy);
      return result;
    } catch (err) {
      this.playwright.reportProxyFailure(session.proxy);
      throw err;
    } finally {
      await session.context.close().catch(() => undefined);
    }
  }

  protected parsePrice(input?: string | null): number | undefined {
    if (!input) return undefined;
    // Greedy: take the first run of digits, then optional thousand groups
    // separated by whitespace or period (handles "7000", "3 500", "3.500",
    // including U+00A0 / U+202F narrow non-breaking spaces). The previous
    // version started with \d{1,3} and would stop at "700" inside "7000".
    const match = input.match(/(\d+(?:[\s.]\d{3})*)/);
    if (!match) return undefined;
    const digits = match[1].replace(/[^\d]/g, '');
    if (!digits.length || digits.length > 7) return undefined; // sanity cap (≤ 9 999 999 PLN)
    return Number.parseInt(digits, 10);
  }

  protected parseArea(input?: string | null): number | undefined {
    if (!input) return undefined;
    const match = input.replace(',', '.').match(/(\d+(?:\.\d+)?)/);
    return match ? Number.parseFloat(match[1]) : undefined;
  }

  /**
   * OLX, Otodom (and most PL portals) show a CMP/RODO modal on first load that
   * blocks the viewport and frequently breaks `domcontentloaded`-based waits.
   * Try a list of known "accept all" buttons; ignore failures (no modal = OK).
   */
  protected async dismissConsent(page: Page): Promise<void> {
    const selectors = [
      'button#onetrust-accept-btn-handler',
      'button[data-testid="cookies-accept-all"]',
      'button[data-cy="accept-consent"]',
      'button:has-text("Akceptuj wszystkie")',
      'button:has-text("Akceptuję")',
      'button:has-text("Zgadzam się")',
      '#didomi-notice-agree-button',
    ];
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(300);
          return;
        }
      } catch {
        // try next selector
      }
    }
  }

  protected matchDistrict(text: string, districts: string[]): string | undefined {
    const lower = text.toLowerCase();
    return districts.find((d) => lower.includes(d.toLowerCase()));
  }
}
