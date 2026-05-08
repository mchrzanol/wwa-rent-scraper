import { Inject, Injectable, Logger } from '@nestjs/common';
import { Listing } from '@prisma/client';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';
import { PrismaService } from '../database/prisma.service';
import type { OrchestratorReport } from '../scrapers/scraper-orchestrator.service';

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
      // ~750ms between posts is comfortably under the 5 req / 2s webhook
      // limit. The bursty channel-specific rate-limit is handled per-call
      // by retry-on-429 inside postEmbed.
      await new Promise((r) => setTimeout(r, 750));
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

    await this.postWithRetry(this.config.discord.webhookUrl, body);
  }

  /**
   * POST a webhook payload, honouring Discord's 429 rate-limit response. On
   * 429 we sleep for `retry_after` (Discord tells us exactly how long to wait)
   * and retry up to MAX_RETRIES times. Non-429 errors bubble up unchanged.
   */
  private async postWithRetry(
    webhookUrl: string,
    body: unknown,
    maxRetries = 3,
  ): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;

      if (res.status === 429) {
        const text = await res.text();
        // Discord returns either a JSON {retry_after: <seconds>} body or a
        // Retry-After header (older API). Prefer the body, fall back to header.
        let retryAfterMs = 1000;
        try {
          const parsed = JSON.parse(text) as { retry_after?: number };
          if (typeof parsed.retry_after === 'number') {
            retryAfterMs = Math.ceil(parsed.retry_after * 1000);
          }
        } catch {
          const header = res.headers.get('retry-after');
          if (header) retryAfterMs = Math.ceil(parseFloat(header) * 1000);
        }
        // Add a small jitter so we don't all wake up at the exact same moment.
        retryAfterMs = Math.min(retryAfterMs + 100, 30_000);

        if (attempt === maxRetries) {
          throw new Error(`Discord HTTP 429 after ${maxRetries} retries: ${text}`);
        }
        this.logger.warn(
          `Discord 429 — sleeping ${retryAfterMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await new Promise((r) => setTimeout(r, retryAfterMs));
        continue;
      }

      throw new Error(`Discord HTTP ${res.status}: ${await res.text()}`);
    }
  }

  /**
   * Posts an end-of-cycle stats summary to a separate informational webhook.
   * Silent no-op if DISCORD_STATS_WEBHOOK_URL is not configured.
   */
  async notifyCycleSummary(
    report: OrchestratorReport | undefined,
    durationMs: number,
    cycleError?: Error,
  ): Promise<void> {
    const url = this.config.discord.statsWebhookUrl;
    if (!url) return;

    const durationStr = `${(durationMs / 1000).toFixed(1)}s`;

    let embed: Record<string, unknown>;
    if (!report) {
      embed = {
        title: '💥 Scrape cycle crashed',
        color: 0xed4245,
        timestamp: new Date().toISOString(),
        description: [
          `Cycle aborted after ${durationStr} before producing a report.`,
          '',
          '```',
          (cycleError?.message ?? 'unknown error').slice(0, 1500),
          '```',
        ].join('\n'),
        footer: { text: 'No listings processed' },
      };
    } else {
      const portalLines = Object.entries(report.perPortal).map(([portal, r]) => {
        const reasons = Object.entries(r.rejectedByReason)
          .sort(([, a], [, b]) => b - a)
          .map(([reason, n]) => `${reason}=${n}`)
          .join(', ');
        const head = `**${portal}** — found ${r.found}, kept ${r.kept}, dup ${r.duplicates}, rejected ${r.rejected}` +
          (r.errors ? `, errors ${r.errors}` : '');
        return reasons ? `${head}\n  └ ${reasons}` : head;
      });

      const totalsLine =
        `**Totals** — found ${report.totals.found}, kept ${report.totals.kept}, ` +
        `duplicates ${report.totals.duplicates}, rejected ${report.totals.rejected} ` +
        `(${durationStr})`;

      const overallReasons = Object.entries(report.rejectedByReason)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([reason, n]) => `\`${reason}\` — ${n}`)
        .join('\n');

      const errorLine = cycleError
        ? `\n\n⚠️ Cycle reported an error: \`${cycleError.message.slice(0, 300)}\``
        : '';

      embed = {
        title: cycleError
          ? '⚠️ Scrape cycle finished with errors'
          : '📊 Scrape cycle complete',
        color: cycleError ? 0xfee75c : report.totals.kept > 0 ? 0x57f287 : 0x99aab5,
        timestamp: new Date().toISOString(),
        description: ([
          totalsLine,
          '',
          ...portalLines,
          ...(overallReasons ? ['', '**Top rejection reasons**', overallReasons] : []),
        ]
          .join('\n') + errorLine).slice(0, 4000),
        footer: { text: `New listings: ${report.newListingIds.length}` },
      };
    }

    try {
      await this.postWithRetry(url, { username: 'rent-scraper-stats', embeds: [embed] });
    } catch (err) {
      this.logger.warn(`Stats webhook failed: ${(err as Error).message}`);
    }
  }
}
