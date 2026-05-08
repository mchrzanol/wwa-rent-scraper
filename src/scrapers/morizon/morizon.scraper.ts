import { Injectable } from '@nestjs/common';
import { Portal } from '@prisma/client';
import { Page } from 'playwright';
import { AbstractPortalScraper } from '../abstract-portal.scraper';
import { ScrapeContext } from '../portal-scraper.interface';
import { RawListing } from '../../common/types/listing.types';
import { PlaywrightService } from '../../playwright/playwright.service';

const BASE = 'https://www.morizon.pl';
const DISTRICT_SLUG: Record<string, string> = {
  'Mokotów': 'mokotow',
  'Wola': 'wola',
  'Praga': 'praga-polnoc',
};

/**
 * Morizon is a Nuxt SPA. The detail pages embed a JSON-LD Offer block
 * (title, description, price) plus a rendered "information table" with
 * area/rooms. Coordinates are not exposed reliably — orchestrator geocodes.
 */
@Injectable()
export class MorizonScraper extends AbstractPortalScraper {
  readonly portal = Portal.MORIZON;

  constructor(playwright: PlaywrightService) {
    super(playwright);
  }

  async fetchListings(ctx: ScrapeContext): Promise<RawListing[]> {
    const results: RawListing[] = [];

    for (const district of ctx.districts) {
      const slug = DISTRICT_SLUG[district];
      if (!slug) {
        this.logger.warn(`No Morizon slug for district "${district}"`);
        continue;
      }

      const allLinks = new Set<string>();
      for (let pageNum = 1; pageNum <= ctx.maxPages; pageNum++) {
        // Morizon uses ?page=N for N>1, omits the param on the first page.
        // ps[with_photo]=1 hides ads with no photos (almost always spam).
        const searchUrl =
          `${BASE}/do-wynajecia/mieszkania/3-pokojowe/warszawa/${slug}/` +
          `?ps%5Bprice_to%5D=${ctx.maxBaseRent}` +
          `&ps%5Bwith_photo%5D=1` +
          (pageNum > 1 ? `&page=${pageNum}` : '');

        this.logger.log(`Morizon: ${district} page ${pageNum}/${ctx.maxPages} → ${searchUrl}`);
        let pageLinks: string[] = [];
        try {
          pageLinks = await this.withPage((page) =>
            this.collectAdLinks(page, searchUrl),
          );
        } catch (err) {
          this.logger.warn(`Morizon: page ${pageNum} failed: ${(err as Error).message}`);
          break;
        }
        if (!pageLinks.length) break;
        const before = allLinks.size;
        for (const l of pageLinks) allLinks.add(l);
        if (allLinks.size === before) break;
      }
      const adLinks = [...allLinks];
      this.logger.log(`Morizon: ${district} → ${adLinks.length} links across ${ctx.maxPages} page(s)`);

      let i = 0;
      for (const url of adLinks) {
        if (ctx.signal?.aborted) return results;
        i += 1;
        try {
          this.logger.log(`Morizon [${i}/${adLinks.length}] ${url}`);
          const listing = await this.withPage((page) =>
            this.parseAdPage(page, url, district),
          );
          if (listing) {
            results.push(listing);
            this.logger.log(`Morizon [${i}/${adLinks.length}] parsed OK`);
          } else {
            this.logger.warn(`Morizon [${i}/${adLinks.length}] parsed → null`);
          }
        } catch (err) {
          this.logger.warn(
            `Morizon [${i}/${adLinks.length}] parse failed: ${(err as Error).message}`,
          );
        }
      }
    }

    return results;
  }

  private async collectAdLinks(page: Page, searchUrl: string): Promise<string[]> {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await this.dismissConsent(page);
    // Cards are present in SSR HTML but may not be in viewport yet → wait for
    // attached, not visible. Restrict to card containers to avoid header/footer
    // promo links like "/oferta-dla-deweloperow/".
    await page.waitForSelector('[data-cy="card"]', {
      state: 'attached',
      timeout: 15_000,
    });
    const hrefs = await page.$$eval('[data-cy="card"] a[href*="/oferta/"]', (els) =>
      els
        .map((e) => (e as HTMLAnchorElement).href)
        .filter((h) => /\/oferta\/.+-mzn\d+/.test(h)),
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

    const externalId = url.match(/mzn(\d+)/)?.[1];
    if (!externalId) return null;

    // JSON-LD Offer holds title (name), description, price, currency.
    await page
      .waitForSelector('script[type="application/ld+json"]', { timeout: 15_000 })
      .catch(() => undefined);

    const offer = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((scripts) => {
        for (const s of scripts) {
          try {
            const j = JSON.parse((s as HTMLScriptElement).textContent ?? '');
            if (j && j['@type'] === 'Offer') return j;
          } catch {
            // ignore non-JSON
          }
        }
        return null;
      });

    const title: string | undefined = offer?.name;
    const description: string | undefined = offer?.description;
    const rentPrice = this.parsePrice(
      offer?.price !== undefined ? String(offer.price) : undefined,
    );

    // Information table: each row has a label span + a value (div or span).
    await page
      .waitForSelector('[data-cy="informationTableRow"]', { timeout: 10_000 })
      .catch(() => undefined);

    const rows = await page.$$eval(
      '[data-cy="informationTableRow"]',
      (els) =>
        els.map((el) => {
          const label = (el.querySelector('[data-cy="informationTableLabel"]') as HTMLElement | null)?.innerText?.trim() ?? '';
          const value = (el.querySelector('[data-cy="itemValue"]') as HTMLElement | null)?.innerText?.trim() ?? '';
          return { label, value };
        }),
    );

    const findRow = (label: string) =>
      rows.find((r) => r.label.toLowerCase().includes(label.toLowerCase()))?.value;

    const areaM2 = this.parseArea(findRow('Pow. całkowita') ?? findRow('Powierzchnia'));
    const roomsRaw = findRow('Liczba pokoi') ?? '';
    const rooms = Number.parseInt(roomsRaw, 10) || 0;

    if (!rentPrice || rentPrice < 500 || !areaM2 || rooms !== 3) {
      this.logger.warn(
        `Morizon skip: rentPrice=${rentPrice} area=${areaM2} rooms=${rooms} for ${url}`,
      );
      return null;
    }

    return {
      portal: this.portal,
      externalId,
      url,
      title: title?.trim(),
      district,
      rooms,
      areaM2,
      rentPrice,
      // adminFee is not exposed as a discrete param on Morizon — buried in
      // free-text description; AI extraction handles it downstream.
      rawDescription: description,
    };
  }
}
