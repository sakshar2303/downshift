import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_PATH = join(".downshift", "pricing.json");
const FETCH_TIMEOUT_MS = 15_000;

/** The subset of OpenRouter's model payload we actually price against. */
export interface OpenRouterModel {
  id: string;
  pricing: {
    /** USD per prompt token, as a decimal string. */
    prompt: string;
    /** USD per completion token, as a decimal string. */
    completion: string;
    /** USD per cached-read token. Missing on many models. */
    input_cache_read?: string;
  };
}

export interface ModelPrice {
  /** OpenRouter model id, e.g. "anthropic/claude-opus-4.8". */
  id: string;
  promptPerToken: number;
  completionPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
}

export type PricingTable = Map<string, ModelPrice>;

interface PricingCache {
  fetchedAt: number;
  data: OpenRouterModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseUsdPerToken(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * OpenRouter does not publish a cache-write price, so we derive one: Anthropic
 * charges 1.25x the prompt rate to write a cache entry, every other provider we
 * track charges the plain prompt rate.
 */
export function cacheWritePricePerToken(
  openRouterId: string,
  promptPerToken: number,
): number {
  return openRouterId.startsWith("anthropic/")
    ? promptPerToken * 1.25
    : promptPerToken;
}

/** Turn the raw OpenRouter list into a price lookup keyed by model id. */
export function buildPricingTable(models: OpenRouterModel[]): PricingTable {
  const table: PricingTable = new Map();
  for (const model of models) {
    if (!isRecord(model) || typeof model.id !== "string") continue;
    const pricing = isRecord(model.pricing) ? model.pricing : undefined;
    if (pricing === undefined) continue;

    const prompt = parseUsdPerToken(pricing.prompt);
    const completion = parseUsdPerToken(pricing.completion);
    if (prompt === undefined || completion === undefined) continue;

    // Models without a cache-read price fall back to the prompt rate rather
    // than $0, so cached input is never silently free.
    const cacheRead = parseUsdPerToken(pricing.input_cache_read) ?? prompt;

    table.set(model.id, {
      id: model.id,
      promptPerToken: prompt,
      completionPerToken: completion,
      cacheReadPerToken: cacheRead,
      cacheWritePerToken: cacheWritePricePerToken(model.id, prompt),
    });
  }
  return table;
}

function readCache(path: string): PricingCache | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) return undefined;
    const fetchedAt =
      typeof parsed.fetchedAt === "number" && Number.isFinite(parsed.fetchedAt)
        ? parsed.fetchedAt
        : 0;
    return { fetchedAt, data: parsed.data as OpenRouterModel[] };
  } catch {
    return undefined;
  }
}

function writeCache(path: string, cache: PricingCache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache), "utf8");
}

async function fetchModels(): Promise<OpenRouterModel[]> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error("OpenRouter returned an unexpected payload");
  }
  return payload.data as OpenRouterModel[];
}

export interface LoadPricingOptions {
  /** Cache file location; defaults to `.downshift/pricing.json` under cwd. */
  cachePath?: string;
  /** Ignore a fresh cache and refetch. */
  refresh?: boolean;
  /** Injectable clock, for tests. */
  now?: () => number;
}

/**
 * Load OpenRouter list prices, using a 24h on-disk cache.
 *
 * The cache is also the offline fallback: a stale cache is better than no
 * prices, so a failed fetch only errors when we have never cached anything.
 */
export async function loadPricing(
  options: LoadPricingOptions = {},
): Promise<PricingTable> {
  const cachePath = options.cachePath ?? CACHE_PATH;
  const now = options.now ?? Date.now;
  const cached = readCache(cachePath);

  if (
    !options.refresh &&
    cached !== undefined &&
    now() - cached.fetchedAt < CACHE_TTL_MS
  ) {
    return buildPricingTable(cached.data);
  }

  try {
    const models = await fetchModels();
    writeCache(cachePath, { fetchedAt: now(), data: models });
    return buildPricingTable(models);
  } catch (error) {
    if (cached !== undefined) {
      const ageHours = Math.round((now() - cached.fetchedAt) / 3_600_000);
      console.error(
        `warning: could not refresh OpenRouter pricing (${error instanceof Error ? error.message : String(error)}); using cached prices from ${ageHours}h ago`,
      );
      return buildPricingTable(cached.data);
    }

    throw new Error(
      `Could not fetch OpenRouter pricing and no cached copy exists at ${cachePath}. Connect to the internet once to seed the cache.`,
    );
  }
}
