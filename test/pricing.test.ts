import { describe, expect, it, vi } from "vitest";
import type { Step } from "../src/types.js";
import {
  applyPricing,
  isLocalModel,
  normalizeClaudeModelId,
  priceStep,
  resetPricingWarnings,
  toOpenRouterId,
} from "../src/pricing/model-map.js";
import {
  buildPricingTable,
  cacheWritePricePerToken,
  type OpenRouterModel,
} from "../src/pricing/openrouter.js";

const models: OpenRouterModel[] = [
  {
    id: "anthropic/claude-opus-4.8",
    pricing: {
      prompt: "0.000005",
      completion: "0.000025",
      input_cache_read: "0.0000005",
    },
  },
  {
    id: "deepseek/deepseek-v4.1-flash",
    pricing: {
      prompt: "0.0000002",
      completion: "0.0000008",
    },
  },
];

function step(overrides: Partial<Step> = {}): Step {
  return {
    id: "step-1",
    index: 0,
    sessionId: "session-1",
    source: "claude-code",
    model: "claude-opus-4-8",
    startedAt: 0,
    tools: [],
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    isSidechain: false,
    ...overrides,
  };
}

describe("normalizeClaudeModelId", () => {
  it("converts trailing version digits to dots", () => {
    expect(normalizeClaudeModelId("claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4.8",
    );
    expect(normalizeClaudeModelId("claude-opus-4-1")).toBe(
      "anthropic/claude-opus-4.1",
    );
  });

  it("drops date suffixes", () => {
    expect(normalizeClaudeModelId("claude-sonnet-4-5-20250929")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(normalizeClaudeModelId("claude-3-opus-20240229")).toBe(
      "anthropic/claude-3-opus",
    );
  });

  it("handles version digits that are not trailing", () => {
    expect(normalizeClaudeModelId("claude-3-5-haiku-20241022")).toBe(
      "anthropic/claude-3.5-haiku",
    );
  });
});

describe("toOpenRouterId", () => {
  it("passes through ids that already carry a provider", () => {
    expect(toOpenRouterId("deepseek/deepseek-v4.1-flash")).toBe(
      "deepseek/deepseek-v4.1-flash",
    );
  });

  it("maps claude ids", () => {
    expect(toOpenRouterId("claude-opus-4-8")).toBe(
      "anthropic/claude-opus-4.8",
    );
  });

  it("returns undefined for local models", () => {
    expect(toOpenRouterId("gemma4:latest")).toBeUndefined();
    expect(toOpenRouterId("llama3.1", "ollama")).toBeUndefined();
    expect(isLocalModel("gemma4:latest")).toBe(true);
    expect(isLocalModel("deepseek/deepseek-v4.1-flash:free")).toBe(false);
  });

  it("honours config overrides", () => {
    expect(
      toOpenRouterId("claude-opus-4-8", undefined, {
        "claude-opus-4-8": "anthropic/claude-opus-4.6",
      }),
    ).toBe("anthropic/claude-opus-4.6");
  });
});

describe("buildPricingTable", () => {
  const table = buildPricingTable(models);

  it("derives a cache-write price of 1.25x prompt for Anthropic", () => {
    expect(cacheWritePricePerToken("anthropic/claude-opus-4.8", 0.000005)).toBe(
      0.00000625,
    );
    expect(table.get("anthropic/claude-opus-4.8")?.cacheWritePerToken).toBe(
      0.00000625,
    );
  });

  it("uses the prompt rate for cache writes elsewhere", () => {
    expect(
      cacheWritePricePerToken("deepseek/deepseek-v4.1-flash", 0.0000002),
    ).toBe(0.0000002);
  });

  it("falls back to prompt for a missing cache-read price", () => {
    expect(table.get("deepseek/deepseek-v4.1-flash")?.cacheReadPerToken).toBe(
      0.0000002,
    );
  });
});

describe("priceStep", () => {
  const pricing = buildPricingTable(models);

  it("prices input, output, cache read and cache write", () => {
    const priced = priceStep(
      step({
        tokens: {
          input: 1000,
          output: 100,
          cacheRead: 2000,
          cacheWrite: 500,
          reasoning: 0,
        },
      }),
      { pricing },
    );

    // 1000*5e-6 + 100*25e-6 + 2000*5e-7 + 500*6.25e-6
    expect(priced.costUsd).toBeCloseTo(
      0.005 + 0.0025 + 0.001 + 0.003125,
      12,
    );
  });

  it("bills reasoning as output only for opencode steps", () => {
    const tokens = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 1000,
    };
    expect(
      priceStep(step({ source: "opencode", tokens }), { pricing }).costUsd,
    ).toBeCloseTo(0.025, 12);
    expect(priceStep(step({ source: "claude-code", tokens }), { pricing }).costUsd).toBe(0);
  });

  it("prices local models at zero", () => {
    const priced = priceStep(step({ model: "gemma4:latest" }), { pricing });
    expect(priced.local).toBe(true);
    expect(priced.costUsd).toBe(0);
  });

  it("warns once for an unknown model and leaves cost undefined", () => {
    resetPricingWarnings();
    const warn = vi.fn();
    const unknown = step({ model: "mystery-model" });

    expect(priceStep(unknown, { pricing, warn }).costUsd).toBeUndefined();
    expect(priceStep(unknown, { pricing, warn }).costUsd).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/mystery-model/);
  });

  it("sums known costs and skips unknown ones in applyPricing", () => {
    const steps = [
      step({
        tokens: {
          input: 1000,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          reasoning: 0,
        },
      }),
      step({ model: "mystery-model" }),
    ];
    resetPricingWarnings();

    const total = applyPricing(steps, { pricing, warn: () => {} });
    expect(total).toBeCloseTo(0.005, 12);
    expect(steps[0]?.costUsd).toBeCloseTo(0.005, 12);
    expect(steps[1]?.costUsd).toBeUndefined();
  });
});
