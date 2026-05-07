import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { chromium as baseChromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, BrowserContext, Page } from 'playwright';
import { ProxyEntry, ProxyRotationService } from './proxy-rotation.service';
import { APP_CONFIG } from '../config/app-config.token';

export { APP_CONFIG };

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

const pickUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

export interface StealthSession {
  context: BrowserContext;
  page: Page;
  /** Proxy used for this context, if any. Pass to reportProxy(success|failure). */
  proxy?: ProxyEntry;
}

@Injectable()
export class PlaywrightService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlaywrightService.name);
  private browser?: Browser;

  constructor(private readonly proxies: ProxyRotationService) {}

  async onModuleInit(): Promise<void> {
    baseChromium.use(StealthPlugin());

    const headless = process.env.HEADLESS !== 'false';
    const slowMo = Number(process.env.SLOW_MO ?? 0) || undefined;
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox',
    ];
    if (!headless) {
      // macOS quirk: without explicit size/position the window can spawn
      // off-screen or with 0×0 dimensions.
      args.push('--window-size=1400,900', '--window-position=80,80');
    }
    this.browser = await baseChromium.launch({ headless, slowMo, args });
    this.logger.log(
      `Playwright browser launched (stealth enabled, headless=${headless}${slowMo ? `, slowMo=${slowMo}ms` : ''})`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close().catch((err) =>
      this.logger.warn(`Browser close failed: ${(err as Error).message}`),
    );
  }

  async newStealthPage(): Promise<StealthSession> {
    if (!this.browser) throw new Error('Playwright browser not initialized');

    const proxy = this.proxies.next();

    const context = await this.browser.newContext({
      userAgent: pickUA(),
      viewport: { width: 1366 + Math.floor(Math.random() * 200), height: 768 },
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      proxy: proxy
        ? {
            server: proxy.server,
            username: proxy.username,
            password: proxy.password,
          }
        : undefined,
      serviceWorkers: 'block',
    });

    await context.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(30_000);
    page.setDefaultTimeout(15_000);

    return { context, page, proxy };
  }

  reportProxySuccess(proxy?: ProxyEntry): void {
    if (proxy) this.proxies.reportSuccess(proxy);
  }

  reportProxyFailure(proxy?: ProxyEntry): void {
    if (proxy) this.proxies.reportFailure(proxy);
  }
}
