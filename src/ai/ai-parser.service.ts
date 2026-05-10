import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';

interface AggregatedResult {
  costs: ParsedCosts;
  address: ExtractedAddress | null;
}

export type ParkingKind = 'PARKING' | 'GARAGE';

export interface ParsedCosts {
  rentPrice?: number;       // base rent stated in description (PLN)
  adminFee?: number;        // "czynsz administracyjny" / building fee (PLN)
  utilities?: number;       // media estimate if separately listed (PLN)
  deposit?: number;         // kaucja (PLN)
  /** Parking kind mentioned in the description, if any. */
  parking?: ParkingKind;
  /** PLN/month. 0 = included in rent/admin. undefined = not mentioned. */
  parkingFee?: number;
  /** 0..1 — model's confidence that adminFee is real, not implied. */
  confidence: number;
  notes?: string;
}

export interface ExtractedAddress {
  /** Street name without "ul." prefix, e.g. "Kolejowa". */
  street?: string;
  /** Building number if present in the text, e.g. "19" or "19A". */
  number?: string;
  /**
   * Fallback location anchor when no street is given. Could be a metro station
   * ("Pole Mokotowskie"), a residential complex ("Mennica Residence"),
   * a shopping mall ("Galeria Mokotów"), etc. Geocoder will look it up.
   */
  landmark?: string;
  /** 0..1 — confidence the extracted token is actually a usable location. */
  confidence: number;
  source: 'regex' | 'ai';
}

const SYSTEM_PROMPT = `You extract structured rental cost information from
Polish real-estate listing descriptions. Return STRICT JSON with keys:
rentPrice, adminFee, utilities, deposit, confidence (0-1), notes.

Rules:
- adminFee = the building/administrative fee paid to the housing cooperative
  ("czynsz administracyjny", "czynsz dla wspólnoty", "opłaty stałe").
- DO NOT include utility estimates ("media", "prąd", "gaz") in adminFee.
- All money values in PLN as integers. Use null for unknown values.
- confidence reflects how explicit the adminFee figure is in the text.
- Output JSON ONLY, no prose, no code fences.`;

/**
 * Polish listings often hide the real "administrative fee" inside prose.
 * Fast deterministic regex misses many cases — we fall back to an LLM via
 * OpenRouter when the regex has nothing or low confidence.
 */
@Injectable()
export class AiParserService {
  private readonly logger = new Logger(AiParserService.name);
  private static readonly RATE_LIMIT_BACKOFFS_MS = [1000, 3000, 5000];

  /**
   * In-memory cache keyed by SHA-1 of the description text. Same description
   * scraped from multiple portals (agency reposts) will hit AI exactly once
   * within the TTL window. Wiped on restart anyway.
   *
   * Bounded by both:
   *   - TTL (default 24h, override via AI_CACHE_TTL_MS)
   *   - max size (default 5000 entries, override via AI_CACHE_MAX_SIZE) —
   *     when full, oldest entries are dropped (Map preserves insertion order).
   */
  private static readonly AI_CACHE_TTL_MS = Number(
    process.env.AI_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000,
  );
  private static readonly AI_CACHE_MAX_SIZE = Number(
    process.env.AI_CACHE_MAX_SIZE ?? 5000,
  );
  private readonly aiCache = new Map<
    string,
    { value: AggregatedResult; expiresAt: number }
  >();
  private aiCacheHits = 0;

  /** Some OR providers ignore response_format and wrap JSON in ```json fences. */
  private stripJsonFence(s: string): string {
    return s
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
  }

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** POST to OpenRouter with 429 retry/backoff. Throws on non-retryable errors. */
  private async openRouterPost(payload: object): Promise<Response> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= AiParserService.RATE_LIMIT_BACKOFFS_MS.length; attempt++) {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.openrouter.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status !== 429) return res;

      const wait = AiParserService.RATE_LIMIT_BACKOFFS_MS[attempt];
      if (wait == null) {
        throw new Error(`OpenRouter HTTP 429 after ${attempt} retries — giving up`);
      }
      this.logger.warn(
        `OpenRouter 429 — backoff ${wait}ms (attempt ${attempt + 1}/${AiParserService.RATE_LIMIT_BACKOFFS_MS.length})`,
      );
      await new Promise((r) => setTimeout(r, wait));
      lastError = new Error(`OpenRouter HTTP 429 (attempt ${attempt + 1})`);
    }
    throw lastError ?? new Error('OpenRouter exhausted retries');
  }

  /** Cheap regex pass — handles the easy 60% of cases with no API cost. */
  regexExtract(description: string): ParsedCosts {
    const out: ParsedCosts = { confidence: 0 };
    const norm = description.replace(/\s+/g, ' ');

    const adminMatch = norm.match(
      /czynsz(?:\s+(?:administracyjny|dla\s+wspólnoty|do\s+spółdzielni))?[^0-9]{0,20}(\d{2,5})\s*(?:zł|pln)/i,
    );
    if (adminMatch) {
      out.adminFee = Number.parseInt(adminMatch[1], 10);
      out.confidence = 0.7;
    }

    const depositMatch = norm.match(/kaucja[^0-9]{0,15}(\d{3,5})\s*(?:zł|pln)/i);
    if (depositMatch) out.deposit = Number.parseInt(depositMatch[1], 10);

    const parking = this.regexExtractParking(norm);
    if (parking) {
      out.parking = parking.kind;
      out.parkingFee = parking.fee;
    }

    return out;
  }

  /**
   * Detects parking/garage mention and (best-effort) monthly fee.
   *   - garage takes priority over open parking when both mentioned
   *   - "w cenie" / "wliczone" / "gratis" → fee = 0
   *   - "X zł / mies" near the parking word → fee = X
   *   - mention without price info → fee = undefined (unknown)
   */
  regexExtractParking(text: string): { kind: ParkingKind; fee?: number } | null {
    const garageRe = /\bgara[żz](?:em|u|y|ami|ach)?\b/i;
    const parkingRe = /\b(?:miejsc[ea]?\s+(?:postojow[eya]|parkingow[eya])|miejsce\s+w\s+hali|parking(?:owe|owy|owa|u|iem)?)\b/i;

    const hasGarage = garageRe.test(text);
    const hasParking = parkingRe.test(text);
    if (!hasGarage && !hasParking) return null;

    const kind: ParkingKind = hasGarage ? 'GARAGE' : 'PARKING';

    // Find an anchor index for the matched word so we can scan a small window
    // around it for a price or "in price" phrase.
    const anchor = (hasGarage ? text.match(garageRe) : text.match(parkingRe))!;
    const idx = anchor.index ?? 0;
    const start = Math.max(0, idx - 60);
    const end = Math.min(text.length, idx + (anchor[0].length) + 80);
    const window = text.slice(start, end);

    if (/\b(?:w\s+cenie|wliczon[ye]|gratis|bezpłatn[ye]|w\s+czynszu)\b/i.test(window)) {
      return { kind, fee: 0 };
    }

    const priceMatch = window.match(/(\d{2,4})\s*(?:zł|pln)\s*(?:\/\s*(?:mies|m-c|miesi[ąa]c)|miesi[ęe]cznie)?/i);
    if (priceMatch) {
      const fee = Number.parseInt(priceMatch[1], 10);
      // Sanity: parking fees are typically 100–800 PLN.
      if (fee >= 30 && fee <= 2000) return { kind, fee };
    }

    return { kind };
  }

  /**
   * Calls OpenRouter only when explicitly asked. Throws on API failure so the
   * caller can decide whether to drop the listing or proceed with regex data.
   */
  async aiExtract(description: string): Promise<ParsedCosts> {
    if (!this.config.openrouter.apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }
    this.logger.log(`→ OpenRouter call: cost extraction (model=${this.config.openrouter.model})`);

    const res = await this.openRouterPost({
      model: this.config.openrouter.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description.slice(0, 6000) },
      ],
    });

    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter response had no content');

    let parsed: Partial<ParsedCosts>;
    try {
      parsed = JSON.parse(this.stripJsonFence(content));
    } catch (err) {
      throw new Error(`Could not JSON.parse model output: ${(err as Error).message}`);
    }

    return {
      rentPrice: this.toIntOrUndef(parsed.rentPrice),
      adminFee: this.toIntOrUndef(parsed.adminFee),
      utilities: this.toIntOrUndef(parsed.utilities),
      deposit: this.toIntOrUndef(parsed.deposit),
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0,
      notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
    };
  }

  /**
   * Hybrid: regex first, then LLM if regex couldn't find adminFee. Returns
   * the merged best guess. Backed by description-hash cache shared with
   * resolveAddress — so a listing using both ends up calling AI at most once.
   */
  async resolveCosts(description: string): Promise<ParsedCosts> {
    const all = await this.extractAll(description);
    return all.costs;
  }

  /**
   * Pulls a Polish street name out of free-form description text. Handles:
   *   - "ul. Kolejowa 19", "ulica Marszałkowska", "przy ul. X"
   *   - "al. Jerozolimskie", "Aleja Solidarności"
   *   - "plac Defilad", "pl. Bankowy"
   * Returns the highest-confidence hit. Polish street names can be in
   * any grammatical case (Kolejowej / Kolejowa) — Nominatim copes well.
   */
  regexExtractAddress(description: string): ExtractedAddress | null {
    const text = description.replace(/\s+/g, ' ');

    // Each pattern captures: 1=street, 2?=number. Ordered most → least specific.
    const patterns: Array<{ re: RegExp; conf: number }> = [
      // "ul. Kolejowa 19" / "ul. Kolejowej 19A"
      {
        re: /\b(?:ul\.?|ulic[ay]|ulicy)\s+([A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ.\-]{2,30}(?:\s+[A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]+){0,2})(?:\s+(\d{1,4}[A-Za-z]?))?/u,
        conf: 0.9,
      },
      // "al. Jerozolimskie 100" / "Aleja Solidarności"
      {
        re: /\b(?:al\.?|alei|aleja|alei)\s+([A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]{2,30}(?:\s+[A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]+){0,2})(?:\s+(\d{1,4}[A-Za-z]?))?/u,
        conf: 0.85,
      },
      // "plac Bankowy" / "pl. Defilad"
      {
        re: /\b(?:pl\.?|plac)\s+([A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]{2,30}(?:\s+[A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]+){0,2})(?:\s+(\d{1,4}[A-Za-z]?))?/u,
        conf: 0.8,
      },
      // "na Warszawskiej 19" / "przy Kolejowej 5" — no "ul." prefix but adjective
      // ending with -skiej/-ckiej/-owej + number is a strong street signal.
      {
        re: /\b(?:przy|na|róg)\s+([A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]+(?:skiej|ckiej|owej|nej|łej|owa|ska|cka))\s+(\d{1,4}[A-Za-z]?)/u,
        conf: 0.7,
      },
      // "Bluszczańska to cicha ulica" / "Marszałkowska to ruchliwa aleja"
      // — bare street name immediately followed by "to ... ulica/aleja".
      {
        re: /\b([A-ZŁŚŻŹĆŃÓĄĘ][\wąćęłńóśźżĄĆĘŁŃÓŚŹŻ\-]{3,30})\s+to\s+(?:\w+\s+){0,3}(?:ulica|aleja|uliczka)\b/u,
        conf: 0.8,
      },
    ];

    for (const { re, conf } of patterns) {
      const m = text.match(re);
      if (m) {
        return {
          street: m[1].trim().replace(/\.$/, ''),
          number: m[2]?.trim(),
          confidence: conf,
          source: 'regex',
        };
      }
    }

    return null;
  }

  private static readonly COMBINED_PROMPT = `You extract structured information from a Polish real-estate listing description. ONE response covers TWO tasks:

OUTPUT: STRICT JSON, single line, no code fences, no commentary.
SCHEMA:
{
  "rentPrice": int|null,
  "adminFee": int|null,
  "utilities": int|null,
  "deposit": int|null,
  "parking": "PARKING"|"GARAGE"|null,
  "parkingFee": int|null,
  "costsConfidence": 0..1,
  "costsNotes": string|null,
  "street": string|null,
  "number": string|null,
  "landmark": string|null,
  "addressConfidence": 0..1
}

================================================================
TASK A — COSTS
================================================================
- adminFee = the building/administrative fee paid to the housing cooperative
  ("czynsz administracyjny", "czynsz dla wspólnoty", "opłaty stałe",
  "czynsz (dodatkowo)", "czynsz dla wspólnoty"). Integer PLN.
- DO NOT roll utility estimates ("media", "prąd", "gaz", "woda") into adminFee.
- deposit = "kaucja". Integer PLN.
- rentPrice / utilities are optional best-effort.
- Use null for unknown values.
- costsConfidence reflects how explicit the adminFee figure is in the text.

PARKING:
- parking = "GARAGE" if the text mentions "garaż", "miejsce w garażu", "garaż podziemny".
- parking = "PARKING" if it mentions "miejsce postojowe", "miejsce parkingowe",
  "miejsce w hali", "parking" but not a garage.
- If both are mentioned, prefer "GARAGE".
- If parking/garage is not mentioned at all → parking = null, parkingFee = null.
- parkingFee = monthly cost in PLN.
    * 0 if "w cenie", "wliczone", "gratis", "bezpłatnie", "w czynszu".
    * integer if a price is given near the word ("garaż 300 zł/mc").
    * null if mentioned without any pricing info.

================================================================
TASK B — ADDRESS / LOCATION ANCHOR
================================================================
You ALMOST ALWAYS find a street. Polish listings nearly always name the street, but the "ul." prefix is often DROPPED. Look at every capitalized word — if it looks like a Polish street name (proper noun, often ends in -ska/-cka/-owa/-skiej/-ka/-a), it IS the street unless it is clearly a district name. Read the WHOLE description before deciding.

DISAMBIGUATION (NEVER put these in "street")
  Districts / neighbourhoods: Mokotów, Stary Mokotów, Wola, Praga, Praga-Północ, Praga-Południe, Saska Kępa, Ursynów, Bemowo, Wilanów, Bielany, Białołęka, Targówek, Ochota, Włochy, Żoliborz, Śródmieście, Wesoła, Rembertów, Wawer.
  Cities / regions: Warszawa, Mazowsze, Mazowieckie.
  General terms: "centrum", "blisko centrum", "okolice".

If no street, fall back to landmark — anything geocodable in OSM:
  - Metro: "stacja metra Pole Mokotowskie" → "Metro Pole Mokotowskie"
  - Residential complex: "Mennica Residence", "Browary Warszawskie"
  - Mall / POI: "Galeria Mokotów", "CH Westfield Mokotów"
  - Park / square: "Pole Mokotowskie", "plac Konstytucji"

ADDRESS NORMALIZATION
  Output street in nominative if you can confidently invert the case ("Kolejowej" → "Kolejowa", "Saskiej" → "Saska"). If unsure keep as written.
  Strip "ul./ulica/al./aleja/plac" from output.
  number: digits only and optional letter ("12", "12A"); strip apartment suffix like "/4".

ADDRESS CONFIDENCE SCALE
  0.95 — explicit street + number ("ul. X 12", "Stańczyka 5")
  0.85 — explicit street name without a number ("ul. X", "X to ulica", "Lokalizacja: X")
  0.75 — declined street form ("na Saskiej", "przy Marszałkowskiej") OR clear landmark
  0.5  — ambiguous mention
  0.0  — only district / city / generic phrasing

================================================================
EXAMPLES
================================================================
INPUT: "Wynajmę mieszkanie. Dokładny adres Stańczyka 5, 3 piętro. Czynsz administracyjny 800 zł, kaucja 4000 zł."
OUTPUT: {"rentPrice":null,"adminFee":800,"utilities":null,"deposit":4000,"parking":null,"parkingFee":null,"costsConfidence":0.9,"costsNotes":null,"street":"Stańczyka","number":"5","landmark":null,"addressConfidence":0.95}

INPUT: "Mieszkanie przy ul. Kolejowej 19/4. Najem 3500 zł + 700 zł czynsz. Miejsce postojowe w hali 250 zł/mc."
OUTPUT: {"rentPrice":3500,"adminFee":700,"utilities":null,"deposit":null,"parking":"PARKING","parkingFee":250,"costsConfidence":0.8,"costsNotes":null,"street":"Kolejowa","number":"19","landmark":null,"addressConfidence":0.95}

INPUT: "Apartament w kompleksie Mennica Residence na Mokotowie. 7000 zł + media. Garaż w cenie."
OUTPUT: {"rentPrice":7000,"adminFee":null,"utilities":null,"deposit":null,"parking":"GARAGE","parkingFee":0,"costsConfidence":0.3,"costsNotes":"media wg zużycia","street":null,"number":null,"landmark":"Mennica Residence","addressConfidence":0.75}

INPUT: "Mieszkanie w Starym Mokotowie. Świetna lokalizacja. 4500 zł czynsz."
OUTPUT: {"rentPrice":4500,"adminFee":null,"utilities":null,"deposit":null,"parking":null,"parkingFee":null,"costsConfidence":0.0,"costsNotes":null,"street":null,"number":null,"landmark":null,"addressConfidence":0.0}

REMEMBER: JSON ONLY. No \`\`\`. No prose. No trailing whitespace.`;

  private static readonly ADDRESS_PROMPT = `You extract Warsaw location anchors from Polish real-estate listing descriptions.

OUTPUT: STRICT JSON, single line, no code fences, no commentary.
SCHEMA: {"street": string|null, "number": string|null, "landmark": string|null, "confidence": number}

YOUR JOB
You ALMOST ALWAYS find a street. Polish listings nearly always name the street, but the "ul." prefix is often DROPPED. Look at every capitalized word — if it looks like a Polish street name (proper noun, often ends in -ska/-cka/-owa/-skiej/-ka/-a), it IS the street unless it is clearly a district name. Read the WHOLE description before deciding.

DISAMBIGUATION (NEVER put these in "street")
  Districts / neighbourhoods: Mokotów, Stary Mokotów, Wola, Praga, Praga-Północ, Praga-Południe, Saska Kępa, Ursynów, Bemowo, Wilanów, Bielany, Białołęka, Targówek, Ochota, Włochy, Żoliborz, Śródmieście, Wesoła, Rembertów, Wawer.
  Cities / regions: Warszawa, Mazowsze, Mazowieckie.
  General terms: "centrum", "blisko centrum", "okolice".

EXAMPLES (input → JSON output)

INPUT: "Wynajmę mieszkanie. Dokładny adres Stańczyka 5, 3 piętro."
OUTPUT: {"street":"Stańczyka","number":"5","landmark":null,"confidence":0.95}

INPUT: "Mieszkanie przy ul. Kolejowej 19/4 w Warszawie."
OUTPUT: {"street":"Kolejowa","number":"19","landmark":null,"confidence":0.95}

INPUT: "Bluszczańska to cicha ulica z dobrym dojazdem do centrum."
OUTPUT: {"street":"Bluszczańska","number":null,"landmark":null,"confidence":0.85}

INPUT: "Lokalizacja: Marszałkowska, Śródmieście."
OUTPUT: {"street":"Marszałkowska","number":null,"landmark":null,"confidence":0.85}

INPUT: "Apartament w kompleksie Mennica Residence na Mokotowie."
OUTPUT: {"street":null,"number":null,"landmark":"Mennica Residence","confidence":0.75}

INPUT: "5 minut piechotą od metra Pole Mokotowskie."
OUTPUT: {"street":null,"number":null,"landmark":"Metro Pole Mokotowskie","confidence":0.7}

INPUT: "Mieszkanie w Starym Mokotowie. Świetna lokalizacja."
OUTPUT: {"street":null,"number":null,"landmark":null,"confidence":0.0}

INPUT: "Lokal znajduje się na Saskiej, blisko Łazienek Królewskich."
OUTPUT: {"street":"Saska","number":null,"landmark":null,"confidence":0.8}

INPUT: "Przestronne mieszkanie w nowoczesnym apartamentowcu Browary Warszawskie. 3 pokoje, 80 m²."
OUTPUT: {"street":null,"number":null,"landmark":"Browary Warszawskie","confidence":0.8}

INPUT: "Mieszkanie 3-pokojowe ul. Pięknej 12/45 — 1 piętro, balkon."
OUTPUT: {"street":"Piękna","number":"12","landmark":null,"confidence":0.95}

CONFIDENCE SCALE
  0.95 — explicit street + number ("ul. X 12", "Stańczyka 5")
  0.85 — explicit street name without a number ("ul. X", "X to ulica", "Lokalizacja: X")
  0.75 — declined street form ("na Saskiej", "przy Marszałkowskiej") OR clear landmark
  0.5  — ambiguous mention
  0.0  — only district / city / generic phrasing

NORMALIZATION
  Output street in nominative if you can confidently invert the case ("Kolejowej" → "Kolejowa", "Saskiej" → "Saska", "Stańczyka" stays "Stańczyka"). If unsure, keep as written. Nominatim handles either.
  Strip "ul./ulica/al./aleja/plac" from output.
  number: digits only and optional letter ("12", "12A"); strip any "/4", "/45" suffix (apartment number, irrelevant).

REMEMBER: JSON ONLY. No \`\`\`. No prose. No trailing whitespace.`;

  async aiExtractAddress(description: string): Promise<ExtractedAddress | null> {
    if (!this.config.openrouter.apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }
    this.logger.log(`→ OpenRouter call: address extraction (model=${this.config.openrouter.model})`);

    const res = await this.openRouterPost({
      model: this.config.openrouter.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AiParserService.ADDRESS_PROMPT },
        { role: 'user', content: description.slice(0, 6000) },
      ],
    });

    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) return null;

    let parsed: {
      street?: string | null;
      number?: string | null;
      landmark?: string | null;
      confidence?: number;
    };
    try {
      parsed = JSON.parse(this.stripJsonFence(content));
    } catch {
      return null;
    }

    const street = typeof parsed.street === 'string' ? parsed.street.trim() : undefined;
    const landmark = typeof parsed.landmark === 'string' ? parsed.landmark.trim() : undefined;
    if (!street && !landmark) return null;

    return {
      street: street || undefined,
      number: parsed.number ? String(parsed.number).trim() : undefined,
      landmark: landmark || undefined,
      confidence:
        typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5,
      source: 'ai',
    };
  }

  /**
   * Hybrid: regex first, AI fallback when regex misses. Returns null only if
   * neither path could extract anything plausible.
   */
  async resolveAddress(description: string): Promise<ExtractedAddress | null> {
    const all = await this.extractAll(description);
    return all.address;
  }

  /**
   * Single source of truth for AI extraction. Runs regex on both fronts; if
   * either is low-confidence it asks the LLM ONCE for both costs and address
   * combined. Caches the merged result by SHA-1(description) so a repost
   * (same text, different URL) hits AI exactly once.
   */
  private async extractAll(description: string): Promise<AggregatedResult> {
    const key = createHash('sha1').update(description).digest('hex');
    const now = Date.now();
    const cached = this.aiCache.get(key);
    if (cached) {
      if (cached.expiresAt > now) {
        this.aiCacheHits += 1;
        this.logger.debug(`AI cache hit (${this.aiCacheHits} total) — key=${key.slice(0, 8)}`);
        return cached.value;
      }
      // Expired — drop it and fall through to recomputation.
      this.aiCache.delete(key);
    }

    const regexCosts = this.regexExtract(description);
    const regexAddress = this.regexExtractAddress(description);

    const costsGoodEnough = regexCosts.adminFee != null && regexCosts.confidence >= 0.7;
    const addressGoodEnough = regexAddress != null && regexAddress.confidence >= 0.8;

    // Both regex paths solved it — no AI call needed.
    if (costsGoodEnough && addressGoodEnough) {
      const result: AggregatedResult = { costs: regexCosts, address: regexAddress };
      this.cacheSet(key, result);
      return result;
    }

    // At least one needs AI. One combined call covers both.
    let ai: { costs?: ParsedCosts; address?: ExtractedAddress | null } = {};
    try {
      ai = await this.aiExtractAll(description);
    } catch (err) {
      this.logger.warn(`AI combined extract failed, falling back to regex: ${(err as Error).message}`);
    }

    const costs: ParsedCosts = ai.costs
      ? {
          ...regexCosts,
          ...ai.costs,
          adminFee: ai.costs.adminFee ?? regexCosts.adminFee,
          deposit: ai.costs.deposit ?? regexCosts.deposit,
          parking: ai.costs.parking ?? regexCosts.parking,
          parkingFee: ai.costs.parkingFee ?? regexCosts.parkingFee,
        }
      : regexCosts;

    let address: ExtractedAddress | null = regexAddress;
    if (ai.address && ai.address.confidence >= 0.4) {
      address = ai.address;
    }

    const result: AggregatedResult = { costs, address };
    this.cacheSet(key, result);
    return result;
  }

  /**
   * Inserts into the AI cache with TTL, opportunistically evicting expired
   * entries and capping total size by dropping oldest (Map preserves insertion
   * order, so first key is the oldest).
   */
  private cacheSet(key: string, value: AggregatedResult): void {
    const now = Date.now();

    // Light sweep: scan the first ~100 entries for expirations. Cheap, doesn't
    // walk the whole map every write.
    let scanned = 0;
    for (const [k, v] of this.aiCache) {
      if (scanned++ >= 100) break;
      if (v.expiresAt <= now) this.aiCache.delete(k);
    }

    // Hard cap — drop oldest until we fit.
    while (this.aiCache.size >= AiParserService.AI_CACHE_MAX_SIZE) {
      const oldest = this.aiCache.keys().next().value;
      if (oldest === undefined) break;
      this.aiCache.delete(oldest);
    }

    this.aiCache.set(key, {
      value,
      expiresAt: now + AiParserService.AI_CACHE_TTL_MS,
    });
  }

  /**
   * Single combined OpenRouter call returning BOTH cost and address in one
   * response — halves spend / latency / rate-limit pressure compared to
   * the two separate calls we used to make.
   */
  private async aiExtractAll(
    description: string,
  ): Promise<{ costs: ParsedCosts; address: ExtractedAddress | null }> {
    if (!this.config.openrouter.apiKey) {
      throw new Error('OPENROUTER_API_KEY not set');
    }
    this.logger.log(`→ OpenRouter call: combined extraction (model=${this.config.openrouter.model})`);

    const res = await this.openRouterPost({
      model: this.config.openrouter.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: AiParserService.COMBINED_PROMPT },
        { role: 'user', content: description.slice(0, 6000) },
      ],
    });

    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenRouter response had no content');

    let parsed: {
      rentPrice?: number | null;
      adminFee?: number | null;
      utilities?: number | null;
      deposit?: number | null;
      parking?: string | null;
      parkingFee?: number | null;
      costsConfidence?: number;
      costsNotes?: string | null;
      street?: string | null;
      number?: string | null;
      landmark?: string | null;
      addressConfidence?: number;
    };
    try {
      parsed = JSON.parse(this.stripJsonFence(content));
    } catch (err) {
      throw new Error(`Could not JSON.parse model output: ${(err as Error).message}`);
    }

    const parkingNorm =
      typeof parsed.parking === 'string'
        ? parsed.parking.trim().toUpperCase()
        : null;
    const parking: ParkingKind | undefined =
      parkingNorm === 'GARAGE' || parkingNorm === 'PARKING' ? parkingNorm : undefined;
    const parkingFeeRaw = this.toIntOrUndef(parsed.parkingFee);
    // Treat 0 as a meaningful value ("included"); only set fee when parking is present.
    const parkingFee = parking ? parkingFeeRaw : undefined;

    const costs: ParsedCosts = {
      rentPrice: this.toIntOrUndef(parsed.rentPrice),
      adminFee: this.toIntOrUndef(parsed.adminFee),
      utilities: this.toIntOrUndef(parsed.utilities),
      deposit: this.toIntOrUndef(parsed.deposit),
      parking,
      parkingFee,
      confidence:
        typeof parsed.costsConfidence === 'number'
          ? Math.max(0, Math.min(1, parsed.costsConfidence))
          : 0,
      notes: typeof parsed.costsNotes === 'string' ? parsed.costsNotes : undefined,
    };

    const street = typeof parsed.street === 'string' ? parsed.street.trim() : undefined;
    const landmark = typeof parsed.landmark === 'string' ? parsed.landmark.trim() : undefined;
    const address: ExtractedAddress | null =
      street || landmark
        ? {
            street: street || undefined,
            number: parsed.number ? String(parsed.number).trim() : undefined,
            landmark: landmark || undefined,
            confidence:
              typeof parsed.addressConfidence === 'number'
                ? Math.max(0, Math.min(1, parsed.addressConfidence))
                : 0,
            source: 'ai',
          }
        : null;

    this.logger.log(
      `← OpenRouter parsed costs(adminFee=${costs.adminFee ?? 'null'} conf=${costs.confidence}) address(${address ? `${address.street ?? address.landmark}` : 'null'} conf=${address?.confidence ?? 0})`,
    );

    return { costs, address };
  }

  private toIntOrUndef(v: unknown): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
    if (typeof v === 'string') {
      const n = Number.parseInt(v.replace(/[^\d]/g, ''), 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  }
}
