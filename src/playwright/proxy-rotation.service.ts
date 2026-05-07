import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../config/app-config.token';

export interface ProxyEntry {
  server: string;     // "http://host:port"
  username: string;
  password: string;
  /** Cooldown until this proxy is eligible again (ms epoch). */
  cooldownUntil: number;
  failures: number;
}

/**
 * Loads proxies from a file (IP:PORT:USER:PASS, one per line) and hands out
 * the next eligible proxy. Failing proxies are temporarily benched. Threadsafe
 * for the single-process Nest runtime — concurrent scrapes share one pool.
 */
@Injectable()
export class ProxyRotationService implements OnModuleInit {
  private readonly logger = new Logger(ProxyRotationService.name);
  private readonly proxies: ProxyEntry[] = [];
  private cursor = 0;

  // Backoff schedule (ms) per consecutive failure
  private static readonly COOLDOWNS = [60_000, 5 * 60_000, 30 * 60_000];

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.proxyFile) {
      this.logger.warn('No PROXY_FILE configured — running without proxies');
      return;
    }
    const abs = path.resolve(this.config.proxyFile);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch (err) {
      this.logger.warn(
        `Could not read proxy file at ${abs}: ${(err as Error).message}`,
      );
      return;
    }

    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      const parts = line.split(':');
      if (parts.length !== 4) {
        this.logger.warn(`Skipping malformed proxy line: "${line}"`);
        continue;
      }
      const [ip, port, username, password] = parts;
      this.proxies.push({
        server: `http://${ip}:${port}`,
        username,
        password,
        cooldownUntil: 0,
        failures: 0,
      });
    }

    this.logger.log(`Loaded ${this.proxies.length} proxies`);
  }

  size(): number {
    return this.proxies.length;
  }

  /**
   * Round-robin pick that skips proxies still in cooldown. Returns undefined
   * if no proxies are loaded; returns the least-recently-failed entry if
   * everyone is cooling down (better than nothing).
   */
  next(): ProxyEntry | undefined {
    if (this.proxies.length === 0) return undefined;
    const now = Date.now();

    for (let i = 0; i < this.proxies.length; i++) {
      const entry = this.proxies[this.cursor];
      this.cursor = (this.cursor + 1) % this.proxies.length;
      if (entry.cooldownUntil <= now) return entry;
    }

    // All in cooldown → pick the one with the soonest expiry.
    return this.proxies.reduce((best, p) =>
      p.cooldownUntil < best.cooldownUntil ? p : best,
    );
  }

  reportSuccess(entry: ProxyEntry): void {
    entry.failures = 0;
    entry.cooldownUntil = 0;
  }

  reportFailure(entry: ProxyEntry): void {
    entry.failures += 1;
    const idx = Math.min(
      entry.failures - 1,
      ProxyRotationService.COOLDOWNS.length - 1,
    );
    entry.cooldownUntil = Date.now() + ProxyRotationService.COOLDOWNS[idx];
    this.logger.warn(
      `Proxy ${entry.server} benched for ${
        ProxyRotationService.COOLDOWNS[idx] / 1000
      }s (failures=${entry.failures})`,
    );
  }
}
