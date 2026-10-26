import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import OpenAI from "openai";

loadEnv();

export type ProviderId = "ollama" | "groq" | "openrouter";

export interface ProviderLimits {
  /** Request token bucket, refilled per minute. */
  requestsPerMinute?: number;
  /** Token bucket for estimated prompt + completion tokens. */
  tokensPerMinute?: number;
  /** Hard daily request cap, persisted on disk. */
  dailyRequests?: number;
}

export interface ProviderConfig {
  id: ProviderId;
  baseURL: string;
  /** Static API key, used by local runtimes that ignore auth. */
  apiKey?: string;
  /** Environment variable holding the key. Never logged. */
  apiKeyEnv?: string;
  defaultHeaders?: Record<string, string>;
  maxContextTokens: number;
  concurrency: number;
  /**
   * Every provider in this registry is a free tier (or local), so the marginal
   * price of a token is zero. Paid routing is out of scope by design.
   */
  priceUsdPerToken: number;
  defaultModel: string;
  limits: ProviderLimits;
}

export const DEFAULT_SMALL_MODEL = "ollama:gemma4:latest";
export const DEFAULT_BIG_MODEL = "groq:openai/gpt-oss-120b";

export const OPENROUTER_DAILY_LIMIT = 45;
const OPENROUTER_USAGE_PATH = join(".downshift", "openrouter-usage.json");

export const providers: Record<ProviderId, ProviderConfig> = {
  ollama: {
    id: "ollama",
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
    maxContextTokens: 16_000,
    concurrency: 1,
    priceUsdPerToken: 0,
    defaultModel: "gemma4:latest",
    limits: {},
  },
  groq: {
    id: "groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    // Free tier is ~8k tokens/minute; keep a safety margin.
    maxContextTokens: 6_000,
    concurrency: 1,
    priceUsdPerToken: 0,
    defaultModel: "openai/gpt-oss-120b",
    limits: { requestsPerMinute: 25, tokensPerMinute: 7_000 },
  },
  openrouter: {
    id: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/sakshar2303/downshift",
      "X-Title": "Downshift",
    },
    maxContextTokens: 24_000,
    concurrency: 1,
    priceUsdPerToken: 0,
    // Free tier is 50/day; leave headroom for other tools on the same key.
    defaultModel: "deepseek/deepseek-v4.1-flash:free",
    limits: {
      requestsPerMinute: 15,
      dailyRequests: OPENROUTER_DAILY_LIMIT,
    },
  },
};

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

function isProviderId(value: string): value is ProviderId {
  return value === "ollama" || value === "groq" || value === "openrouter";
}

/**
 * Parse "provider:model". Only the first colon separates the provider, so
 * "ollama:gemma4:latest" and "openrouter:deepseek/x:free" keep their model ids
 * intact.
 */
export function parseModelRef(ref: string): ModelRef {
  const separator = ref.indexOf(":");
  if (separator <= 0 || separator === ref.length - 1) {
    throw new Error(
      `Invalid model reference "${ref}". Expected "provider:model", for example "ollama:gemma4:latest".`,
    );
  }

  const provider = ref.slice(0, separator);
  const model = ref.slice(separator + 1);
  if (!isProviderId(provider)) {
    throw new Error(
      `Unknown provider "${provider}" in model reference "${ref}". Expected one of: ollama, groq, openrouter.`,
    );
  }
  if (model.trim() === "") {
    throw new Error(`Empty model id in reference "${ref}".`);
  }

  return { provider, model };
}

let allowPaidByDefault = false;

/** Set by the CLI's --allow-paid flag; library callers can still override per call. */
export function configureProviders(options: { allowPaid?: boolean }): void {
  if (options.allowPaid !== undefined) allowPaidByDefault = options.allowPaid;
}

/**
 * Free guard: OpenRouter is only called with ":free" models unless paid use is
 * explicitly opted into. This is the last line of defence for the $0 promise.
 */
export function assertModelAllowed(
  ref: ModelRef | string,
  options: { allowPaid?: boolean } = {},
): void {
  const parsed = typeof ref === "string" ? parseModelRef(ref) : ref;
  if (parsed.provider !== "openrouter") return;

  if (parsed.model.endsWith(":free")) return;
  if (options.allowPaid ?? allowPaidByDefault) return;

  throw new Error(
    `Refusing paid OpenRouter model "${parsed.model}": Downshift only calls :free models by default. Pass --allow-paid to override.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
  }

  private refill(now: number): void {
    const elapsed = now - this.updatedAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(
      this.capacity,
      this.tokens + elapsed * this.refillPerMs,
    );
    this.updatedAt = now;
  }

  async take(amount: number): Promise<void> {
    const cost = Math.min(Math.max(1, amount), this.capacity);
    for (;;) {
      const now = Date.now();
      this.refill(now);
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = Math.ceil((cost - this.tokens) / this.refillPerMs);
      await sleep(Math.max(1, waitMs));
    }
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // The releaser hands its slot directly to us, so active is not incremented
    // again here — otherwise a late caller could race past the limit.
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

interface ProviderLimiters {
  requests?: TokenBucket;
  tokens?: TokenBucket;
  semaphore: Semaphore;
}

const limiters = new Map<ProviderId, ProviderLimiters>();

function limitersFor(provider: ProviderConfig): ProviderLimiters {
  const existing = limiters.get(provider.id);
  if (existing !== undefined) return existing;

  const created: ProviderLimiters = {
    semaphore: new Semaphore(provider.concurrency),
    requests:
      provider.limits.requestsPerMinute === undefined
        ? undefined
        : new TokenBucket(
            provider.limits.requestsPerMinute,
            provider.limits.requestsPerMinute / 60_000,
          ),
    tokens:
      provider.limits.tokensPerMinute === undefined
        ? undefined
        : new TokenBucket(
            provider.limits.tokensPerMinute,
            provider.limits.tokensPerMinute / 60_000,
          ),
  };
  limiters.set(provider.id, created);
  return created;
}

interface DailyUsage {
  date: string;
  count: number;
}

function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function readDailyUsage(): DailyUsage | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(OPENROUTER_USAGE_PATH, "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.date !== "string" ||
      typeof record.count !== "number" ||
      !Number.isFinite(record.count)
    ) {
      return undefined;
    }
    return { date: record.date, count: record.count };
  } catch {
    return undefined;
  }
}

function takeOpenRouterDaily(limit: number): void {
  const today = todayKey();
  const stored = readDailyUsage();
  const usage: DailyUsage =
    stored !== undefined && stored.date === today
      ? { date: today, count: stored.count }
      : { date: today, count: 0 };

  if (usage.count >= limit) {
    throw new Error(
      `OpenRouter free-tier daily limit reached (${limit}/${limit}). Try again tomorrow.`,
    );
  }

  usage.count += 1;
  mkdirSync(dirname(OPENROUTER_USAGE_PATH), { recursive: true });
  writeFileSync(OPENROUTER_USAGE_PATH, JSON.stringify(usage), "utf8");
}

function estimateTokens(
  messages: ChatMessage[],
  tools: ChatTool[] | undefined,
  maxTokens: number | undefined,
): number {
  // Cheap character heuristic; only used to reserve groq's free token budget.
  const payload = JSON.stringify({ messages, tools });
  return Math.ceil(payload.length / 4) + (maxTokens ?? 0);
}

async function acquireSlot(
  provider: ProviderConfig,
  estimatedTokens: number,
): Promise<() => void> {
  const limiter = limitersFor(provider);
  await limiter.semaphore.acquire();

  try {
    if (limiter.requests !== undefined) await limiter.requests.take(1);
    if (limiter.tokens !== undefined) await limiter.tokens.take(estimatedTokens);
    if (provider.limits.dailyRequests !== undefined) {
      takeOpenRouterDaily(provider.limits.dailyRequests);
    }
  } catch (error) {
    limiter.semaphore.release();
    throw error;
  }

  return () => limiter.semaphore.release();
}

const clients = new Map<ProviderId, OpenAI>();

function apiKeyFor(provider: ProviderConfig): string {
  if (provider.apiKey !== undefined) return provider.apiKey;
  if (provider.apiKeyEnv === undefined) {
    throw new Error(`Provider "${provider.id}" has no API key configured.`);
  }
  const key = process.env[provider.apiKeyEnv];
  if (key === undefined || key.trim() === "") {
    throw new Error(
      `${provider.apiKeyEnv} is not set. Add it to .env or the environment.`,
    );
  }
  return key;
}

function clientFor(provider: ProviderConfig): OpenAI {
  const existing = clients.get(provider.id);
  if (existing !== undefined) return existing;

  const client = new OpenAI({
    apiKey: apiKeyFor(provider),
    baseURL: provider.baseURL,
    defaultHeaders: provider.defaultHeaders,
    // We implement our own retry loop so backoff and Retry-After stay visible.
    maxRetries: 0,
  });
  clients.set(provider.id, client);
  return client;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as Record<string, unknown>).status;
  return typeof status === "number" ? status : undefined;
}

function headerFromError(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const headers = (error as Record<string, unknown>).headers;
  if (headers === undefined) return undefined;

  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  const value = headerFromError(error, "retry-after");
  if (value === undefined) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));

  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  return undefined;
}

function isRetryable(error: unknown): boolean {
  const status = statusOf(error);
  return status === 429 || (status !== undefined && status >= 500);
}

const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 90_000;

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ChatTool[];
  maxTokens?: number;
  temperature?: number;
  /** Explicit paid opt-in for this call; overrides configureProviders(). */
  allowPaid?: boolean;
}

export interface ChatResult {
  message: OpenAI.Chat.Completions.ChatCompletionMessage;
  usage: OpenAI.Chat.Completions.ChatCompletion["usage"];
  latencyMs: number;
}

/**
 * Send one chat completion through an OpenAI-compatible free-tier provider.
 *
 * Applies the provider's concurrency and rate limits, the OpenRouter daily cap
 * and free guard, retries 429/5xx with backoff, and enforces a 90s timeout.
 */
export async function chat(
  modelRef: string,
  options: ChatOptions,
): Promise<ChatResult> {
  const ref = parseModelRef(modelRef);
  assertModelAllowed(ref, { allowPaid: options.allowPaid });

  const provider = providers[ref.provider];
  const client = clientFor(provider);
  const release = await acquireSlot(
    provider,
    estimateTokens(options.messages, options.tools, options.maxTokens),
  );

  try {
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: ref.model,
      messages: options.messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    };
    if (options.tools !== undefined) body.tools = options.tools;

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await client.chat.completions.create(body, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        const message = response.choices[0]?.message;
        if (message === undefined) {
          throw new Error(`${provider.id} returned no message choices.`);
        }
        return {
          message,
          usage: response.usage,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === MAX_RETRIES) break;
        const delay =
          retryAfterMs(error) ?? Math.min(30_000, 1_000 * 2 ** attempt);
        await sleep(delay);
      }
    }

    throw lastError;
  } finally {
    release();
  }
}