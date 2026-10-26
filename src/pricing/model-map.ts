import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Step } from "../types.js";
import type { ModelPrice, PricingTable } from "./openrouter.js";

const CONFIG_FILE = "downshift.config.yaml";
const DATE_SUFFIX = /-(\d{8})$/;

/** Models warned about already, so one unknown id doesn't spam every step. */
const warnedModels = new Set<string>();

/** Test hook: forget which unknown models have been warned about. */
export function resetPricingWarnings(): void {
  warnedModels.clear();
}

/**
 * Local runtimes are free: Ollama-served models, and bare ids carrying a tag
 * like "gemma4:latest". Anything with a provider prefix is an API model.
 */
export function isLocalModel(model: string, provider?: string): boolean {
  if (provider?.toLowerCase() === "ollama") return true;
  if (model.includes("/")) return false;
  return /:[^/]+$/.test(model);
}

/**
 * Convert a Claude Code model id to its OpenRouter id:
 * "claude-opus-4-8" -> "anthropic/claude-opus-4.8", and date-stamped ids lose
 * the suffix ("claude-sonnet-4-5-20250929" -> "anthropic/claude-sonnet-4.5").
 * Runs of adjacent numeric segments are version parts and become dotted.
 */
export function normalizeClaudeModelId(model: string): string {
  const withoutDate = model.replace(DATE_SUFFIX, "");
  const parts = withoutDate.split("-");
  const joined: string[] = [];

  for (const part of parts) {
    const previous = joined[joined.length - 1];
    const isVersionPart = /^\d+$/.test(part);
    const previousIsVersionPart =
      previous !== undefined && /^\d+(?:\.\d+)*$/.test(previous);

    if (isVersionPart && previousIsVersionPart) {
      joined[joined.length - 1] = `${previous}.${part}`;
    } else {
      joined.push(part);
    }
  }

  return `anthropic/${joined.join("-")}`;
}

/**
 * Map a transcript model id to an OpenRouter id. Returns undefined for local
 * models, which cost nothing and never need a price lookup.
 */
export function toOpenRouterId(
  model: string,
  provider?: string,
  overrides: Record<string, string> = {},
): string | undefined {
  const override = overrides[model];
  if (override !== undefined) return override;
  if (isLocalModel(model, provider)) return undefined;
  if (model.includes("/")) return model;
  if (model.startsWith("claude-")) return normalizeClaudeModelId(model);
  return model;
}

/** Read `modelMap` overrides from downshift.config.yaml, if the file exists. */
export function loadModelOverrides(cwd: string = process.cwd()): Record<
  string,
  string
> {
  const path = join(cwd, CONFIG_FILE);
  if (!existsSync(path)) return {};

  try {
    const parsed: unknown = parseYaml(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};

    const modelMap = (parsed as Record<string, unknown>).modelMap;
    if (typeof modelMap !== "object" || modelMap === null) return {};

    const overrides: Record<string, string> = {};
    for (const [from, to] of Object.entries(modelMap)) {
      if (typeof to === "string" && to.trim() !== "") overrides[from] = to.trim();
    }
    return overrides;
  } catch {
    // A malformed config should not stop analysis; fall back to built-in rules.
    console.error(`warning: could not read ${path}; ignoring model overrides`);
    return {};
  }
}

export interface PriceStepOptions {
  pricing: PricingTable;
  overrides?: Record<string, string>;
  warn?: (message: string) => void;
}

export interface StepPrice {
  openRouterId?: string;
  local: boolean;
  costUsd?: number;
}

/**
 * Price one step at public list rates.
 *
 * cost = input*prompt + output*completion + cacheRead*cache_read
 *      + cacheWrite*cacheWrite + (opencode ? reasoning*completion : 0)
 *
 * Reasoning is billed as output only for OpenCode sessions: Claude Code does
 * not report reasoning tokens separately, so adding them would double-count.
 */
export function priceStep(
  step: Step,
  options: PriceStepOptions,
): StepPrice {
  const overrides = options.overrides ?? {};
  const openRouterId = toOpenRouterId(step.model, step.provider, overrides);

  if (openRouterId === undefined) {
    return { local: true, costUsd: 0 };
  }

  const price: ModelPrice | undefined = options.pricing.get(openRouterId);
  if (price === undefined) {
    if (!warnedModels.has(openRouterId)) {
      warnedModels.add(openRouterId);
      const warn = options.warn ?? ((message: string) => console.error(message));
      warn(
        `warning: no OpenRouter price for "${step.model}" (looked up as "${openRouterId}"); cost left unknown`,
      );
    }
    return { openRouterId, local: false, costUsd: undefined };
  }

  const tokens = step.tokens;
  let costUsd =
    tokens.input * price.promptPerToken +
    tokens.output * price.completionPerToken +
    tokens.cacheRead * price.cacheReadPerToken +
    tokens.cacheWrite * price.cacheWritePerToken;

  if (step.source === "opencode") {
    costUsd += tokens.reasoning * price.completionPerToken;
  }

  return { openRouterId, local: false, costUsd };
}

/** Price every step in place, returning the session total. */
export function applyPricing(
  steps: Step[],
  options: PriceStepOptions,
): number {
  let total = 0;
  for (const step of steps) {
    const priced = priceStep(step, options);
    step.costUsd = priced.costUsd;
    total += priced.costUsd ?? 0;
  }
  return total;
}
