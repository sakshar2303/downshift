import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { MATCH_THRESHOLD } from "../judge/action-match.js";
import { toOpenRouterId } from "../pricing/model-map.js";
import type { PricingTable } from "../pricing/openrouter.js";
import type { ReplayRecord } from "../replay/run.js";
import type { StepKind, Tokens } from "../types.js";

/** Stable kind order so policy files diff cleanly between runs. */
const KIND_ORDER: StepKind[] = [
  "read",
  "search",
  "web",
  "edit",
  "test",
  "shell",
  "plan",
  "delegate",
  "other",
];

const MIN_SAMPLES = 2;

function kindRank(kind: StepKind): number {
  const rank = KIND_ORDER.indexOf(kind);
  return rank === -1 ? KIND_ORDER.length : rank;
}

export interface ModelStats {
  model: string;
  samples: number;
  meanScore: number;
  /** Share of samples at or above the 0.8 match threshold. */
  matchRate: number;
}

export type EvidenceByKind = Map<StepKind, ModelStats[]>;

export interface PolicyEvidence {
  model: string;
  matchRate: number;
  samples: number;
}

export interface RoutingPolicy {
  version: 1;
  frontier: string;
  threshold: number;
  route: Record<string, string>;
  evidence: Record<string, PolicyEvidence>;
}

export interface PolicyBuildOptions {
  threshold: number;
  frontier?: string;
  minSamples?: number;
  /**
   * Relative list-price rank for a model ref. Lower is cheaper; local models
   * should return 0 and unknown models Infinity.
   */
  priceRank: (modelRef: string) => number;
}

/** Aggregate scored replay records per kind and model. */
export function aggregateEvidence(
  records: ReadonlyArray<
    Pick<ReplayRecord, "kind" | "modelRef" | "score" | "error">
  >,
): EvidenceByKind {
  const buckets = new Map<StepKind, Map<string, number[]>>();

  for (const record of records) {
    if (record.error !== undefined) continue;
    if (typeof record.score !== "number" || !Number.isFinite(record.score)) {
      continue;
    }
    const score = Math.min(1, Math.max(0, record.score));
    const byModel = buckets.get(record.kind) ?? new Map<string, number[]>();
    const scores = byModel.get(record.modelRef) ?? [];
    scores.push(score);
    byModel.set(record.modelRef, scores);
    buckets.set(record.kind, byModel);
  }

  const evidence: EvidenceByKind = new Map();
  const kinds = [...buckets.keys()].sort(
    (a, b) => kindRank(a) - kindRank(b) || a.localeCompare(b),
  );

  for (const kind of kinds) {
    const byModel = buckets.get(kind);
    if (byModel === undefined) continue;

    const stats: ModelStats[] = [];
    for (const [model, scores] of byModel) {
      const meanScore =
        scores.reduce((sum, score) => sum + score, 0) / scores.length;
      const matches = scores.filter((score) => score >= MATCH_THRESHOLD).length;
      stats.push({
        model,
        samples: scores.length,
        meanScore,
        matchRate: matches / scores.length,
      });
    }

    stats.sort(
      (a, b) =>
        b.matchRate - a.matchRate ||
        b.samples - a.samples ||
        a.model.localeCompare(b.model),
    );
    evidence.set(kind, stats);
  }

  return evidence;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Choose a route per kind: the cheapest model that clears the match-rate
 * threshold with enough samples, otherwise the frontier.
 */
export function selectRoutes(
  evidence: EvidenceByKind,
  options: PolicyBuildOptions,
  frontier: string,
): RoutingPolicy {
  const minSamples = options.minSamples ?? MIN_SAMPLES;
  const route: Record<string, string> = {};
  const fileEvidence: Record<string, PolicyEvidence> = {};

  for (const [kind, stats] of evidence) {
    if (stats.length === 0) continue;

    const best = [...stats].sort(
      (a, b) =>
        b.matchRate - a.matchRate ||
        b.samples - a.samples ||
        a.model.localeCompare(b.model),
    )[0] as ModelStats;
    const eligible = stats.filter(
      (entry) =>
        entry.samples >= minSamples && entry.matchRate >= options.threshold,
    );
    const cheapest = [...eligible].sort(
      (a, b) =>
        options.priceRank(a.model) - options.priceRank(b.model) ||
        a.model.localeCompare(b.model),
    )[0];

    const chosen = cheapest ?? best;
    route[kind] = cheapest === undefined ? "frontier" : chosen.model;
    fileEvidence[kind] = {
      model: chosen.model,
      matchRate: round4(chosen.matchRate),
      samples: chosen.samples,
    };
  }

  return {
    version: 1,
    frontier,
    threshold: options.threshold,
    route,
    evidence: fileEvidence,
  };
}

export interface PolicyReplayReport {
  session: { model: string };
  records: ReadonlyArray<
    Pick<ReplayRecord, "kind" | "modelRef" | "score" | "error">
  >;
}

/** Build a policy from a replay report. */
export function buildPolicy(
  report: PolicyReplayReport,
  options: PolicyBuildOptions,
): RoutingPolicy {
  const evidence = aggregateEvidence(report.records);
  const frontier = options.frontier ?? report.session.model;
  if (frontier.trim() === "") {
    throw new Error(
      "The replay report has no session model; pass a frontier model explicitly.",
    );
  }
  return selectRoutes(evidence, options, frontier);
}

/** Serialize a policy in the documented YAML shape. */
export function policyToYaml(policy: RoutingPolicy): string {
  return stringifyYaml(policy, { lineWidth: 0 });
}

export function writePolicyFile(
  policy: RoutingPolicy,
  path = "downshift.policy.yaml",
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, policyToYaml(policy), "utf8");
  return path;
}

export interface TokenPrice {
  promptPerToken: number;
  completionPerToken: number;
  cacheReadPerToken: number;
  cacheWritePerToken: number;
}

export const ZERO_PRICE: TokenPrice = {
  promptPerToken: 0,
  completionPerToken: 0,
  cacheReadPerToken: 0,
  cacheWritePerToken: 0,
};

/** List-price lookup for model refs. Local and :free models cost zero. */
export function createPriceLookup(
  pricing: PricingTable,
): (modelRef: string) => TokenPrice | undefined {
  return (modelRef) => {
    const trimmed = modelRef.trim();
    if (trimmed === "") return undefined;

    const separator = trimmed.indexOf(":");
    const provider = separator > 0 ? trimmed.slice(0, separator) : undefined;
    const model =
      separator > 0 ? trimmed.slice(separator + 1) : trimmed;

    if (provider === "ollama") return ZERO_PRICE;
    if (model.endsWith(":free")) return ZERO_PRICE;

    const openRouterId = toOpenRouterId(model, provider);
    if (openRouterId === undefined) return ZERO_PRICE;
    return pricing.get(openRouterId);
  };
}

export function listPriceRank(
  lookup: (modelRef: string) => TokenPrice | undefined,
): (modelRef: string) => number {
  return (modelRef) => {
    const price = lookup(modelRef);
    if (price === undefined) return Number.POSITIVE_INFINITY;
    return price.promptPerToken + price.completionPerToken;
  };
}

/** Price one step's token counts at a list rate. */
export function priceTokens(tokens: Tokens, price: TokenPrice): number {
  return (
    tokens.input * price.promptPerToken +
    tokens.output * price.completionPerToken +
    tokens.cacheRead * price.cacheReadPerToken +
    tokens.cacheWrite * price.cacheWritePerToken +
    // Reasoning tokens are generated tokens and bill as output.
    tokens.reasoning * price.completionPerToken
  );
}

export interface SavingsStep {
  kind: StepKind;
  tokens: Tokens;
}

export interface KindSavings {
  kind: StepKind;
  model: string;
  steps: number;
  beforeUsd: number;
  afterUsd: number;
  savedUsd: number;
}

export interface ProjectedSavings {
  beforeUsd: number;
  afterUsd: number;
  savedUsd: number;
  savedPct: number;
  /** Only kinds that route away from the frontier. */
  kinds: KindSavings[];
}

/**
 * Re-price every step of a downshifted kind at the routed model's list price.
 * Token counts are unchanged; only the rate differs. Local and :free models
 * are $0. A missing route price falls back to the frontier rate, so an unknown
 * model can never manufacture savings.
 */
export function computeProjectedSavings(
  steps: ReadonlyArray<SavingsStep>,
  policy: Pick<RoutingPolicy, "frontier" | "route">,
  lookup: (modelRef: string) => TokenPrice | undefined,
): ProjectedSavings {
  const frontierPrice = lookup(policy.frontier);
  const routes = new Map<string, string | undefined>();
  const routePrices = new Map<string, TokenPrice | undefined>();

  for (const [kind, route] of Object.entries(policy.route)) {
    const model = route === "frontier" ? policy.frontier : route;
    routes.set(kind, model);
    routePrices.set(
      kind,
      model === policy.frontier
        ? frontierPrice
        : (lookup(model) ?? frontierPrice),
    );
  }

  const kindTotals = new Map<StepKind, KindSavings>();
  let beforeUsd = 0;
  let afterUsd = 0;

  for (const step of steps) {
    const before = frontierPrice === undefined ? 0 : priceTokens(step.tokens, frontierPrice);
    const routedModel = routes.get(step.kind);
    const routedPrice = routePrices.get(step.kind);
    const appliedPrice = routedPrice ?? frontierPrice;
    const after = appliedPrice === undefined ? 0 : priceTokens(step.tokens, appliedPrice);

    beforeUsd += before;
    afterUsd += after;

    if (routedModel !== undefined && routedModel !== policy.frontier) {
      const entry = kindTotals.get(step.kind) ?? {
        kind: step.kind,
        model: routedModel,
        steps: 0,
        beforeUsd: 0,
        afterUsd: 0,
        savedUsd: 0,
      };
      entry.steps += 1;
      entry.beforeUsd += before;
      entry.afterUsd += after;
      entry.savedUsd += before - after;
      kindTotals.set(step.kind, entry);
    }
  }

  const savedUsd = beforeUsd - afterUsd;
  return {
    beforeUsd,
    afterUsd,
    savedUsd,
    savedPct: beforeUsd > 0 ? (savedUsd / beforeUsd) * 100 : 0,
    kinds: [...kindTotals.values()].sort(
      (a, b) => b.savedUsd - a.savedUsd || kindRank(a.kind) - kindRank(b.kind),
    ),
  };
}