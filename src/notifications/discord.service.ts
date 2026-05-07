import { Inject, Injectable, Logger } from '@nestjs/common';
import { Listing } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { PrismaService } from '../database/prisma.service';

const PORTAL_COLORS: Record<string, number> = {
  OTODOM: 0x00a3a1,
  OLX: 0x002f34,
  GRATKA: 0xe2231a,
  MORIZON: 0x004a8f,
  NIERUCHOMOSCI_ONLINE: 0xf39200,
  RENTOLA: 0x1a73e8,
};

@Injectable()
export class DiscordService {
  private readonly logger = new Logger(DiscordService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sends one embed per listing, sequentially with a small delay to stay
   * inside the 5 req/2s webhook rate limit. Marks listings as notified so a
   * crashed cycle doesn't double-post.
   */
  async notifyMany(listingIds: string[]): Promise<void> {
    if (!listingIds.length) return;
    if (!this.config.discord.webhookUrl) {
      this.logger.warn('DISCORD_WEBHOOK_URL not set — skipping notifications');
      return;
    }

    const listings = await this.prisma.listing.findMany({
      where: { id: { in: listingIds }, notifiedAt: null },
    });

    for (const listing of listings) {
      try {
        await this.postEmbed(listing);
        await this.prisma.listing.update({
          where: { id: listing.id },
          data: { notifiedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(
          `Discord push failed for ${listing.url}: ${(err as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Strip CSS rule fragments that leaked into title via textContent scraping. */
  private cleanTitle(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let s = raw
      .replace(/\.css-[a-z0-9]+\s*\{[^}]*\}/gi, '')
      .replace(/\{\s*[\w-]+:[^}]+\}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s.length ? s : null;
  }

  private async postEmbed(listing: Listing): Promise<void> {
    const cleanedTitle = this.cleanTitle(listing.title);
    const embed = {
      title:
        cleanedTitle?.slice(0, 240) ?? `${listing.rooms}-pok., ${listing.district}`,
      url: listing.url,
      color: PORTAL_COLORS[listing.portal] ?? 0x5865f2,
      timestamp: new Date().toISOString(),
      footer: { text: `${listing.portal} • ${listing.district}` },
      fields: [
        {
          name: '💰 Total / month',
          value: `**${listing.totalPrice} PLN**${
            listing.adminFee != null
              ? ` (rent ${listing.rentPrice} + admin ${listing.adminFee})`
              : ` (rent ${listing.rentPrice})`
          }`,
          inline: false,
        },
        {
          name: '📐 Area',
          value: `${listing.areaM2} m² • ${listing.rooms} rooms`,
          inline: true,
        },
        {
          name: '🚇 Subway',
          value:
            listing.walkingMeters != null
              ? listing.walkingApproximate
                ? `~${listing.walkingMeters} m straight-line → **${listing.nearestStation}** (approx, routing unavailable)`
                : `${listing.walkingMeters} m walk → **${listing.nearestStation}**`
              : `~${listing.haversineMeters} m → ${listing.nearestStation}`,
          inline: true,
        },
        {
          name: '🔒 Deposit',
          value: listing.deposit != null ? `${listing.deposit} PLN` : '—',
          inline: true,
        },
      ],
    };

    if (listing.phone) {
      embed.fields.push({ name: '📞 Phone', value: listing.phone, inline: true });
    }

    const body = {
      username: 'rent-scraper',
      embeds: [embed],
      // Plain content gives mobile push previews a useful summary.
      content: `**${listing.totalPrice} PLN** · ${listing.areaM2} m² · ${listing.district} · ${
        listing.walkingMeters ?? listing.haversineMeters
      } m → ${listing.nearestStation}`,
    };

    const res = await fetch(this.config.discord.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      throw new Error(`Discord HTTP ${res.status}: ${await res.text()}`);
    }
  }
}
