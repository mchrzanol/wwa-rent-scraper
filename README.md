# rent-scraper

# Im pretty exhausted about searching so I vibecoded it, can have a lot of bugs and be not useful in every case. Take care of this creature;P - pzdr

Warsaw real-estate scraper that finds 3-room apartments under a strict budget,
within walking distance of a metro station. Built on NestJS + Prisma + Playwright.
Sends hits to Discord and a Google Sheet.

## What it does

For each portal (Otodom, OLX) and each configured district, the scraper:

1. Walks the search results page (filtered by max base rent, 3 rooms).
2. Opens every detail page through Playwright + stealth plugin (rotating proxies).
3. Pulls a `RawListing` (rent, admin fee, area, deposit, coords, description).
4. Pushes it through the orchestrator pipeline.
5. New, qualifying listings get appended to Sheets and posted to Discord.

A cron schedules a **shallow** cycle every full hour 06–22 Europe/Warsaw, and
one **deep** cycle daily at 12:00 (walks more pages per portal × district).

## Pipeline (per listing)

```
scrape  ─▶  rooms == 3  ?
        ─▶  totalPrice = rent + adminFee  (AI fallback if adminFee missing)
        ─▶  totalPrice ≤ MAX_TOTAL_PRICE  ?
        ─▶  resolve coordinates (scraper-provided OR
                                 regex street OR
                                 AI street/landmark OR
                                 district centroid)
        ─▶  Haversine prefilter ≤ HAVERSINE_PREFILTER_METERS  ?
        ─▶  ORS walking distance       (1° fallback: OSRM public,
                                         2° fallback: Haversine, marked approx)
        ─▶  walkingMeters ≤ MAX_WALKING_METERS  ?
        ─▶  fingerprint dedup against DB
        ─▶  insert as PUBLISHED
        ─▶  cycle end: Sheets append → Discord notify (newListingIds only)
```

Anything that fails any check is rejected with a tagged reason and shown in the
end-of-cycle breakdown log (`rejectedByReason`).

## Stack

- **NestJS 10** (`@nestjs/schedule` for cron, modular DI)
- **Prisma 5** + Postgres 16 (Listing / ScrapeRun / DuplicateLink)
- **Playwright** + `playwright-extra` + `puppeteer-extra-plugin-stealth`
- **OpenRouteService** for foot-walking distance, **OSRM public** as fallback
- **Nominatim** for free-text geocoding
- **OpenRouter** (Claude Haiku 4.5 by default) for parsing prices/addresses
- **Google Sheets API** + **Discord webhooks** as sinks

## Setup

```bash
cp .env.example .env                                 # fill in API keys
echo "1.2.3.4:6967:user:pass" >> proxy.txt           # one proxy per line, optional
mkdir -p secrets && mv ~/Downloads/sa-*.json secrets/sa.json   # Google service account
npm install
npx playwright install chromium
npm run db:up                                        # docker compose up -d postgres
npx prisma migrate deploy                            # or `prisma db push` for dev
npm run start:dev
```

## NPM scripts

| Script | Description |
| --- | --- |
| `npm run start:dev` | Hot-reload dev server (Nest watch mode) |
| `npm run start` | Production: `node dist/main.js` |
| `npm run build` | Compile TS to `dist/` |
| `npm run db:up` | Start Postgres in Docker (background) |
| `npm run db:down` | Stop and remove Postgres container (volume kept) |
| `npm run prisma:migrate` | Create/apply a new dev migration |
| `npm run prisma:deploy` | Apply pending migrations (use in prod) |
| `npm run prisma:generate` | Regenerate Prisma client |
| `npm run playwright:install` | Download Chromium for Testing |

## Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres URL, e.g. `postgresql://rent:rent@localhost:5432/rent_scraper` |
| `ORS_API_KEY` | yes | OpenRouteService key (40 req/min free tier) |
| `OPENROUTER_API_KEY` | optional | Falls back to regex-only if missing — flags more listings as `unverifiable_location` |
| `OPENROUTER_MODEL` | optional | Default `anthropic/claude-haiku-4.5` |
| `DISCORD_WEBHOOK_URL` | optional | If unset, Discord sink is disabled |
| `GOOGLE_SHEETS_ID` | optional | Sheets target spreadsheet ID |
| `GOOGLE_SA_JSON` | optional | Path to service-account JSON file (or inline JSON blob) |
| `NOMINATIM_BASE_URL` | optional | Default `https://nominatim.openstreetmap.org` |
| `NOMINATIM_USER_AGENT` | yes if using Nominatim | TOS requires identifying UA |
| `PROXY_FILE` | optional | Path to `IP:PORT:USER:PASS` list. Default `./proxy.txt`. Empty file = no proxies. |
| `MAX_BASE_RENT` | optional | Used in portal URL filters (default 4000 PLN, leaves headroom for admin fee) |
| `MAX_ITEMS_PER_DISTRICT` | optional | Per-district result-page cap (currently 1 page) |
| `DEEP_SCRAPE_PAGES` | optional | Pages walked at noon deep scan (default 5) |
| `HEADLESS` | optional | Set to `false` to launch Chromium with a visible window for debugging |
| `SLOW_MO` | optional | Playwright slowMo in ms (debugging) |
| `PORT` | optional | HTTP port for health controller (default 3000) |

## Filters (in `src/config/configuration.ts`)

- Districts: Mokotów, Wola, Praga (override with `FILTER_DISTRICTS`, comma-separated)
- Rooms: exactly 3
- Max total price: 5000 PLN (rent + admin fee)
- Walking distance to subway: ≤ 1500 m (OSRM/ORS) — listing kept as approximate if both routers fail
- Haversine prefilter: 1800 m straight-line (skips the ORS call when far)

## HTTP endpoints

The app exposes a small health controller for manual smoke tests:

- `GET /test` — returns `{ status, env, uptimeSeconds, db, cycleRunning, timestamp }`.
- `POST /test/scrape?pages=N` — fires a scrape cycle in the background. Without `pages`,
  uses `DEEP_SCRAPE_PAGES`. Returns 202 immediately; watch logs for progress.

## Logs

Per-listing logs spell out which step rejected each ad:

```
▶ [OTODOM] https://... — rooms=3, area=68m², rent=3500, admin=?
  ↳ adminFee/deposit missing → calling AI cost extractor
→ OpenRouter call: cost extraction (model=anthropic/claude-haiku-4.5)
  ↳ AI returned adminFee=400, deposit=4000 (confidence=0.85)
  ✓ price OK (3900 ≤ 5000)
  ↳ geocoded → 52.18234,21.00531 (road)
→ ORS call for Wilanowska (haversine=842m)
← ORS returned 1043m walk to Wilanowska
✗ [OTODOM] ... REJECT walk_distance_exceeded — nearest=Wilanowska, hav=842m, walk=1043m
```

End-of-cycle dump:

```
Cycle done — found 240, kept 2, duplicates 1, rejected 237
=== REJECTED BREAKDOWN ===
[total_price_exceeded] 180 listing(s):
    [OTODOM] https://www.otodom.pl/...
    ...
[walk_distance_exceeded] 40 listing(s):
    ...
==========================
```

## Project layout

```
src/
├── main.ts                         # bootstrap (HTTP server)
├── app.module.ts
├── config/
│   ├── configuration.ts            # central AppConfig loader
│   ├── app-config.token.ts         # DI token (kept separate to avoid cycles)
│   └── subway-stations.ts          # all Warsaw metro coords
├── playwright/
│   ├── playwright.service.ts       # browser lifecycle, stealth, headless flag
│   └── proxy-rotation.service.ts   # proxy file loader + cooldown
├── scrapers/
│   ├── portal-scraper.interface.ts # Strategy Pattern entry point
│   ├── abstract-portal.scraper.ts  # withPage helper, parsePrice, dismissConsent
│   ├── otodom/                     # __NEXT_DATA__ JSON parser
│   ├── olx/                        # DOM-based parser with selector fallbacks
│   └── scraper-orchestrator.service.ts
├── routing/
│   ├── routing.service.ts          # ORS + OSRM fallback + throttle + retry
│   └── geocoding.service.ts        # Nominatim with TOS-compliant rate limit
├── ai/
│   └── ai-parser.service.ts        # regex first, OpenRouter fallback
├── deduplication/
│   └── deduplication.service.ts    # fingerprint + fuzzy match
├── notifications/
│   └── discord.service.ts          # one embed per new listing
├── sheets/
│   └── google-sheets.service.ts    # auto-creates "Listings" tab + header
├── cron/
│   └── scrape.cron.ts              # hourly shallow + daily deep
└── health/
    └── health.controller.ts        # /test endpoints
```

## Notes

- The Otodom scraper relies on the `__NEXT_DATA__` JSON blob; if Otodom changes
  their app, only `parseAdPage` needs updating.
- The OLX scraper uses DOM selectors with multi-fallback; OLX rotates `data-cy`
  / `data-testid` attributes routinely. If something breaks, run with
  `HEADLESS=false` to inspect the live page and add new selectors to
  `src/scrapers/olx/olx.scraper.ts`.
- ORS rate-limit handling lives in `src/routing/routing.service.ts` —
  default cap is 35 req/min with 5/15/30 s exponential backoff on 429s,
  then OSRM, then Haversine.
- Postgres unique constraint on `Listing.url` means re-scraping the same ad
  on the next cycle is a no-op (skipped at the start of `processOne`).
