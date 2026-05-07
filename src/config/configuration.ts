export interface AppConfig {
  filters: {
    districts: string[];
    rooms: number;
    maxTotalPrice: number;
    maxBaseRent: number;
    maxWalkingMeters: number;
    haversinePrefilterMeters: number;
  };
  proxyFile?: string;
  ors: { apiKey: string; baseUrl: string };
  openrouter: { apiKey: string; model: string };
  nominatim: { baseUrl: string; userAgent: string };
  discord: { webhookUrl: string };
  sheets: { spreadsheetId: string; serviceAccountJson: string; sheetName: string };
  database: { url: string };
}

export const loadConfig = (): AppConfig => ({
  filters: {
    districts: (process.env.FILTER_DISTRICTS ?? 'Mokotów,Wola,Praga')
      .split(',')
      .map((d) => d.trim()),
    rooms: 3,
    maxTotalPrice: 5000,
    maxBaseRent: Number(process.env.MAX_BASE_RENT ?? 4000),
    maxWalkingMeters: Number(process.env.MAX_WALKING_METERS ?? 1500),
    haversinePrefilterMeters: Number(
      process.env.HAVERSINE_PREFILTER_METERS ?? Number(process.env.MAX_WALKING_METERS ?? 1500) * 1.2,
    ),
  },
  proxyFile: process.env.PROXY_FILE ?? './proxy.txt',
  ors: {
    apiKey: process.env.ORS_API_KEY ?? '',
    baseUrl: 'https://api.openrouteservice.org/v2/directions/foot-walking',
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-haiku-4.5',
  },
  nominatim: {
    baseUrl: process.env.NOMINATIM_BASE_URL ?? 'https://nominatim.openstreetmap.org',
    userAgent:
      process.env.NOMINATIM_USER_AGENT ?? 'rent-scraper/1.0 (set NOMINATIM_USER_AGENT)',
  },
  discord: { webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '' },
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEETS_ID ?? '',
    serviceAccountJson: process.env.GOOGLE_SA_JSON ?? '',
    sheetName: process.env.SHEET_NAME ?? 'Listings',
  },
  database: { url: process.env.DATABASE_URL ?? '' },
});
