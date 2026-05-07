import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../playwright/playwright.service';

export interface ParsedCosts {
  rentPrice?: number;       // base rent stated in description (PLN)
  adminFee?: number;        // "czynsz administracyjny" / building fee (PLN)
  utilities?: number;       // media estimate if separately listed (PLN)
  deposit?: number;         // kaucja (PLN)
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

    return out;
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
   * the merged best guess.
   */
  async resolveCosts(description: string): Promise<ParsedCosts> {
    const regex = this.regexExtract(description);
    if (regex.adminFee && regex.confidence >= 0.7) return regex;

    try {
      const ai = await this.aiExtract(description);
      return {
        ...regex,
        ...ai,
        // Take whichever path actually found an adminFee
        adminFee: ai.adminFee ?? regex.adminFee,
        deposit: ai.deposit ?? regex.deposit,
      };
    } catch (err) {
      this.logger.warn(`AI extract failed, returning regex only: ${(err as Error).message}`);
      return regex;
    }
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

  private static readonly ADDRESS_PROMPT = `You extract Warsaw location anchors
from Polish real-estate listing descriptions. Return STRICT JSON:
{"street": "<street name in nominative without 'ul.' prefix, or null>", "number": "<building number or null>", "landmark": "<POI/metro station/residential complex/mall name in Warsaw, or null>", "confidence": 0..1}

PRIORITY (return the strongest anchor available):
  1. STREET NAME — highest priority. Look HARD; streets in Polish text often
     appear WITHOUT the "ul." prefix. Patterns to recognize (★ = explicit,
     ◐ = implicit but reliable):
       ★ "ul. Kolejowa 19" / "ulica Marszałkowska"
       ★ "al. Jerozolimskie 100" / "Aleja Solidarności"
       ★ "plac Bankowy" / "pl. Defilad"
       ◐ "Bluszczańska to cicha ulica" — Bluszczańska is the street
       ◐ "Mieszkanie przy Kolejowej" / "na Marszałkowskiej" — declined form
       ◐ "Bluszczańska 12 / 4" — number after the bare name
       ◐ "Lokalizacja: Bluszczańska, Mokotów" — header-style mention
     Polish streets can appear in any grammatical case (genitive "Kolejowej",
     locative "Kolejowej") — return them in the form as written or normalize
     to nominative if confident. Nominatim handles either.
     CRITICAL DISAMBIGUATION: "Stary Mokotów", "Saska Kępa", "Wola",
     "Mokotów", "Śródmieście" are NEIGHBOURHOODS, NOT streets. Never put
     them in "street". Same for "Warszawa".

  2. LANDMARK — only if no street is mentioned. Anything geocodable in OSM:
       - Metro: "stacja metra Pole Mokotowskie" → "Metro Pole Mokotowskie"
       - Residential complex: "Mennica Residence", "Browary Warszawskie"
       - Mall / POI: "Galeria Mokotów", "CH Westfield Mokotów"
       - Park / square: "Pole Mokotowskie", "plac Konstytucji"
     Pick the SPECIFIC anchor (the building / mall / station), not generic
     references like "blisko parku".

  3. If neither street nor landmark, return all-null with confidence 0.

CONFIDENCE:
  0.95 — explicit "ul. X 12" with number
  0.85 — explicit "ul. X" or "X to ulica" pattern, no number
  0.75 — declined street name in context ("przy Kolejowej")
  0.7  — clear landmark (named building/mall/metro)
  0.3  — vague hint
  0.0  — nothing

OUTPUT JSON ONLY. No prose, no code fences, no comments.`;

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
    const regex = this.regexExtractAddress(description);
    if (regex && regex.confidence >= 0.8) return regex;

    try {
      const ai = await this.aiExtractAddress(description);
      if (ai && ai.confidence >= 0.4) return ai;
    } catch (err) {
      this.logger.warn(`AI address extract failed: ${(err as Error).message}`);
    }

    return regex; // may still be a low-confidence regex hit, or null
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
