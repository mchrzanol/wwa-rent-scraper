import { Injectable } from '@nestjs/common';
import { Portal } from '@prisma/client';
import { Page } from 'playwright';
import { AbstractPortalScraper } from '../abstract-portal.scraper';
import { ScrapeContext } from '../portal-scraper.interface';
import { RawListing } from '../../common/types/listing.types';
import { PlaywrightService } from '../../playwright/playwright.service';

const BASE = 'https://www.otodom.pl';
const DISTRICT_SLUG: Record<string, string> = {
  'Mokotów': 'mokotow',
  'Wola': 'wola',
  'Praga': 'praga-polnoc',
};

/**
 * Otodom uses Next.js — most listing pages embed a __NEXT_DATA__ JSON blob
 * which is far more reliable than DOM scraping. We pull the search results
 * page, follow each ad link, and parse __NEXT_DATA__ for structured data.
 */
@Injectable()
export class OtodomScraper extends AbstractPortalScraper {
  readonly portal = Portal.OTODOM;

  constructor(playwright: PlaywrightService) {
    super(playwright);
  }

  async fetchListings(ctx: ScrapeContext): Promise<RawListing[]> {
    const results: RawListing[] = [];

    for (const district of ctx.districts) {
      const slug = DISTRICT_SLUG[district];
      if (!slug) {
        this.logger.warn(`No Otodom slug for district "${district}"`);
        continue;
      }

      const allLinks = new Set<string>();
      for (let pageNum = 1; pageNum <= ctx.maxPages; pageNum++) {
        const searchUrl =
          `${BASE}/pl/wyniki/wynajem/mieszkanie/mazowieckie/warszawa/warszawa/warszawa/${slug}` +
          `?ownerTypeSingleSelect=ALL` +
          `&priceMax=${ctx.maxBaseRent}` +
          `&roomsNumber=%5BTHREE%5D` +
          `&by=LATEST&direction=DESC` +
          `&limit=36&page=${pageNum}`;

        this.logger.log(`Otodom: ${district} page ${pageNum}/${ctx.maxPages} → ${searchUrl}`);
        let pageLinks: string[] = [];
        try {
          pageLinks = await this.withPage((page) =>
            this.collectAdLinks(page, searchUrl),
          );
        } catch (err) {
          this.logger.warn(`Otodom: page ${pageNum} failed: ${(err as Error).message}`);
          break;
        }
        if (!pageLinks.length) break;
        const before = allLinks.size;
        for (const l of pageLinks) allLinks.add(l);
        if (allLinks.size === before) break; // no new links → end of pagination
      }
      const adLinks = [...allLinks];
      this.logger.log(`Otodom: ${district} → ${adLinks.length} links across ${ctx.maxPages} page(s)`);

      let i = 0;
      for (const url of adLinks) {
        if (ctx.signal?.aborted) return results;
        i += 1;
        try {
          this.logger.log(`Otodom [${i}/${adLinks.length}] ${url}`);
          const listing = await this.withPage((page) =>
            this.parseAdPage(page, url, district),
          );
          if (listing) {
            results.push(listing);
            this.logger.log(`Otodom [${i}/${adLinks.length}] parsed OK`);
          } else {
            this.logger.warn(`Otodom [${i}/${adLinks.length}] parsed → null`);
          }
        } catch (err) {
          this.logger.warn(
            `Otodom [${i}/${adLinks.length}] parse failed: ${(err as Error).message}`,
          );
        }
      }
    }

    return results;
  }

  private async collectAdLinks(page: Page, searchUrl: string): Promise<string[]> {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await this.dismissConsent(page);
    // Otodom renders results client-side; wait for the listing list selector.
    await page.waitForSelector('[data-cy="listing-item-link"]', { timeout: 15_000 });
    const hrefs = await page.$$eval(
      '[data-cy="listing-item-link"]',
      (els) => els.map((e) => (e as HTMLAnchorElement).href),
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

    const nextData = await page
      .locator('script#__NEXT_DATA__')
      .textContent({ timeout: 10_000 });
    if (!nextData) return null;

    const json = JSON.parse(nextData);
    const ad = json?.props?.pageProps?.ad;
    if (!ad) return null;

    const characteristics: Array<{ key: string; value: string }> =
      ad.characteristics ?? [];
    const get = (key: string) => characteristics.find((c) => c.key === key)?.value;

    const rentPrice = this.parsePrice(get('price'));
    const adminFee = this.parsePrice(get('rent'));
    const deposit = this.parsePrice(get('deposit'));
    const areaM2 = this.parseArea(get('m'));
    const rooms = Number.parseInt(get('rooms_num') ?? '0', 10);

    if (!rentPrice || !areaM2 || !rooms) return null;

    return {
      portal: this.portal,
      externalId: String(ad.id),
      url,
      title: ad.title,
      district,
      rooms,
      areaM2,
      rentPrice,
      adminFee,
      deposit,
      latitude: ad.location?.coordinates?.latitude,
      longitude: ad.location?.coordinates?.longitude,
      phone: ad.contactDetails?.phones?.[0],
      postedAt: ad.createdAt ? new Date(ad.createdAt) : undefined,
      rawDescription: ad.description,
    };
  }
}
