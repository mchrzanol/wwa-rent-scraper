import { Injectable } from '@nestjs/common';
import { Portal } from '@prisma/client';
import { Page } from 'playwright';
import { AbstractPortalScraper } from '../abstract-portal.scraper';
import { ScrapeContext } from '../portal-scraper.interface';
import { RawListing } from '../../common/types/listing.types';
import { PlaywrightService } from '../../playwright/playwright.service';

const BASE = 'https://www.olx.pl';

/**
 * OLX is a mix of native OLX listings and embedded Otodom ones. We skip
 * Otodom-on-OLX pages (they share a separate scraper) and parse only native
 * OLX detail pages.
 */
@Injectable()
export class OlxScraper extends AbstractPortalScraper {
  readonly portal = Portal.OLX;

  constructor(playwright: PlaywrightService) {
    super(playwright);
  }

  async fetchListings(ctx: ScrapeContext): Promise<RawListing[]> {
    const results: RawListing[] = [];

    for (const district of ctx.districts) {
      const districtSlug = district
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/\s+/g, '-');

      const allLinks = new Set<string>();
      for (let pageNum = 1; pageNum <= ctx.maxPages; pageNum++) {
        const url =
          `${BASE}/nieruchomosci/mieszkania/wynajem/warszawa/q-${districtSlug}/` +
          `?search%5Bfilter_float_price%3Ato%5D=${ctx.maxBaseRent}` +
          `&search%5Bfilter_enum_rooms%5D%5B0%5D=three` +
          `&page=${pageNum}`;

        this.logger.log(`OLX: ${district} page ${pageNum}/${ctx.maxPages} → ${url}`);
        let pageLinks: string[] = [];
        try {
          pageLinks = await this.withPage((page) =>
            this.collectAdLinks(page, url),
          );
        } catch (err) {
          this.logger.warn(`OLX: page ${pageNum} failed: ${(err as Error).message}`);
          break;
        }
        if (!pageLinks.length) break;
        const before = allLinks.size;
        for (const l of pageLinks) allLinks.add(l);
        if (allLinks.size === before) break;
      }
      const adLinks = [...allLinks];
      this.logger.log(`OLX: ${district} → ${adLinks.length} links across ${ctx.maxPages} page(s)`);

      let i = 0;
      for (const link of adLinks) {
        if (ctx.signal?.aborted) return results;
        if (link.includes('otodom.pl')) continue; // handled by OtodomScraper
        i += 1;
        try {
          this.logger.log(`OLX [${i}/${adLinks.length}] ${link}`);
          const listing = await this.withPage((page) =>
            this.parseAdPage(page, link, district),
          );
          if (listing) {
            results.push(listing);
            this.logger.log(`OLX [${i}/${adLinks.length}] parsed OK`);
          } else {
            this.logger.warn(`OLX [${i}/${adLinks.length}] parsed → null`);
          }
        } catch (err) {
          this.logger.warn(
            `OLX [${i}/${adLinks.length}] parse failed: ${(err as Error).message}`,
          );
        }
      }
    }

    return results;
  }

  private async collectAdLinks(page: Page, url: string): Promise<string[]> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.dismissConsent(page);
    await page.waitForSelector('[data-cy="l-card"] a', { timeout: 15_000 });
    const hrefs = await page.$$eval('[data-cy="l-card"] a', (els) =>
      els
        .map((e) => (e as HTMLAnchorElement).href)
        .filter((h) => h && !h.includes('#')),
    );
    return Array.from(new Set(hrefs));
  }

  private async parseAdPage(
    page: Page,
    url: string,
    district: string,
  ): Promise<RawListing | null> {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.dismissConsent(page);

    const externalId = url.match(/-ID([A-Za-z0-9]+)\.html/)?.[1];
    if (!externalId) return null;

    // OLX rotates DOM frequently — try multiple selectors per field, each with
    // a short timeout, fall back to null if all miss. Parsing must not hang.
    // We use innerText (rendered text) instead of textContent because OLX
    // emits <style> tags inside content elements; textContent leaks raw CSS.
    const tryText = async (selectors: string[], timeout = 3000): Promise<string | null> => {
      for (const sel of selectors) {
        try {
          const loc = page.locator(sel).first();
          await loc.waitFor({ state: 'attached', timeout });
          const t = await loc.evaluate((el) => (el as HTMLElement).innerText);
          if (t && t.trim()) return t.trim();
        } catch {
          // try next
        }
      }
      return null;
    };

    const title = await tryText([
      '[data-testid="offer_title"]',  // current OLX (May 2026)
      '[data-cy="ad_title"]',          // legacy fallback
      'h4[data-cy="myAd_title"]',
    ]);

    const priceText = await tryText([
      '[data-testid="ad-price-container"]',
      '[data-cy="ad_price"]',
      'h3[data-testid="ad-price"]',
    ]);
    const rentPrice = this.parsePrice(priceText);

    // OLX parameters: try newer (<p>) and older (<li>) layouts
    let params: string[] = [];
    for (const sel of [
      '[data-testid="ad-parameters-container"] p',
      '[data-testid="ad-parameters-container"] li',
      'ul.css-px2l1d li',
    ]) {
      try {
        params = await page.$$eval(sel, (els) =>
          els.map((e) => (e as HTMLElement).innerText.trim()),
        );
        if (params.length) break;
      } catch {
        // try next
      }
    }

    const findParam = (label: string) =>
      params
        .find((p) => p.toLowerCase().includes(label.toLowerCase()))
        ?.split(':')[1]
        ?.trim();

    const areaM2 = this.parseArea(findParam('Powierzchnia'));
    const roomsRaw = findParam('Liczba pokoi') ?? '';
    const rooms =
      /3|trzy/i.test(roomsRaw) ? 3 : Number.parseInt(roomsRaw, 10) || 0;
    const adminFee = this.parsePrice(findParam('Czynsz'));

    const description = await tryText([
      '[data-cy="ad_description"]',
      'div[data-testid="ad-description"]',
    ]);

    // Sanity: a 3-room flat in Warsaw cannot rent for under 500 PLN/mo. If
    // we got a tiny number, parsing leaked a digit from CSS class names or
    // similar — drop it instead of polluting the DB.
    if (!rentPrice || rentPrice < 500 || !areaM2 || rooms !== 3) {
      this.logger.warn(
        `OLX skip: rentPrice=${rentPrice} area=${areaM2} rooms=${rooms} params=${params.length} priceText=${JSON.stringify(priceText?.slice(0, 80))} for ${url}`,
      );
      return null;
    }

    // OLX hides phones behind a click; we DO NOT click it (would break stealth).
    return {
      portal: this.portal,
      externalId,
      url,
      title: title?.trim(),
      district,
      rooms,
      areaM2,
      rentPrice,
      adminFee,
      // OLX doesn't reliably expose coordinates → orchestrator must geocode
      // by district centroid as a fallback (out of scope for this file).
      rawDescription: description?.trim() ?? undefined,
    };
  }
}
