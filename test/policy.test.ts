import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  ZERO_PRICE,
  aggregateEvidence,
  buildPolicy,
  computeProjectedSavings,
  createPriceLookup,
  listPriceRank,
  policyToYaml,
  priceTokens,
  selectRoutes,
  writePolicyFile,
  type ModelStats,
  type RoutingPolicy,
  type TokenPrice,
} from "../src/policy/policy.js";
import type { ModelPrice, PricingTable } from "../src/pricing/openrouter.js";
import type { ReplayRecord } from "../src/replay/run.js";
import type { StepKind, Tokens } from "../src/types.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "downshift-policy-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(
  kind: ReplayRecord["kind"],
  modelRef: string,
  score: number | undefined,
  error?: string,
): Pick<ReplayRecord, "kind" | "modelRef" | "score" | "error"> {
  return { kind, modelRef, score, error };
}

function tokens(overrides: Partial<Tokens> = {}): Tokens {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    ...overrides,
  };
}

function price(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return {
    id: "test/model",
    promptPerToken: 1 / 1_000_000,
    completionPerToken: 3 / 1_000_000,
    cacheReadPerToken: 0.1 / 1_000_000,
    cacheWritePerToken: 1.25 / 1_000_000,
    ...overrides,
  };
}

function model(
  name: string,
  samples: number,
  matchRate: number,
  meanScore = matchRate,
): ModelStats {
  return { model: name, samples, matchRate, meanScore };
}

describe("aggregateEvidence", () => {
  const records = [
    record("read", "ollama:small", 1),
    record("read", "ollama:small", 0.8),
    record("read", "groq:big", 0.5),
    record("read", "groq:big", 0.2),
    record("search", "groq:big", 1),
    record("search", "groq:big", 1),
    record("search", "groq:big", 1),
    record("edit", "groq:big", 1, "rate limited"),
    record("edit", "groq:big", undefined),
  ];

  it("groups by kind and model, ignoring errors and unscored records", () => {
    const evidence = aggregateEvidence(records);
    expect([...evidence.keys()]).toEqual(["read", "search"]);
    const read = evidence.get("read");
    expect(read).toHaveLength(2);

    const local = read?.find((entry) => entry.model === "ollama:small");
    expect(local?.samples).toBe(2);
    expect(local?.meanScore).toBeCloseTo(0.9, 10);
    expect(local?.matchRate).toBe(1);

    const big = read?.find((entry) => entry.model === "groq:big");
    expect(big?.matchRate).toBe(0);
    expect(big?.meanScore).toBeCloseTo(0.35, 10);
  });

  it("counts exactly 0.8 as a match", () => {
    const evidence = aggregateEvidence([record("test", "a", 0.8)]);
    expect(evidence.get("test")?.[0]?.matchRate).toBe(1);
  });

  it("clamps out-of-range scores", () => {
    const evidence = aggregateEvidence([
      record("read", "a", 1.4),
      record("read", "a", -1),
    ]);
    const stats = evidence.get("read")?.[0];
    expect(stats?.meanScore).toBeCloseTo(0.5, 10);
    expect(stats?.matchRate).toBe(0.5);
  });

  it("sorts kinds in canonical order and models by quality", () => {
    const evidence = aggregateEvidence([
      record("other", "a", 0.1),
      record("read", "low", 0.2),
      record("read", "high", 1),
      record("read", "high", 1),
    ]);
    expect([...evidence.keys()]).toEqual(["read", "other"]);
    expect(evidence.get("read")?.map((entry) => entry.model)).toEqual([
      "high",
      "low",
    ]);
  });
});

describe("selectRoutes", () => {
  const priceRank = (modelRef: string): number => {
    if (modelRef.startsWith("ollama:")) return 0;
    if (modelRef.includes(":free")) return 0;
    if (modelRef.startsWith("groq:")) return 1;
    return Number.POSITIVE_INFINITY;
  };

  it("chooses the cheapest eligible model", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
        "read",
        [
          model("groq:big", 3, 1),
          model("ollama:small", 2, 0.9),
          model("openrouter:other:free", 2, 0.95),
        ],
      ],
    ]);
    const policy = selectRoutes(
      evidence,
      { threshold: 0.9, priceRank },
      "frontier/model",
    );
    // Ollama and :free are both $0; model ref order breaks the tie.
    expect(policy.route.read).toBe("ollama:small");
    expect(policy.evidence.read).toEqual({
      model: "ollama:small",
      matchRate: 0.9,
      samples: 2,
    });
  });

  it("skips a cheaper model below the threshold", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
        "read",
        [
          model("ollama:small", 3, 0.89),
          model("groq:big", 3, 0.9),
        ],
      ],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.9, priceRank }, "x");
    expect(policy.route.read).toBe("groq:big");
  });

  it("requires at least two samples by default", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
        "search",
        [
          model("ollama:small", 1, 1),
          model("groq:big", 2, 1),
        ],
      ],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.8, priceRank }, "x");
    expect(policy.route.search).toBe("groq:big");
  });

  it("honours a custom minimum sample count", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
"search", [model("ollama:small", 1, 1)]],
    ]);
    const policy = selectRoutes(
      evidence,
      { threshold: 0.8, priceRank, minSamples: 1 },
      "x",
    );
    expect(policy.route.search).toBe("ollama:small");
  });

  it("falls back to the frontier when nothing qualifies", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
        "edit",
        [model("ollama:small", 2, 0.4), model("groq:big", 2, 0.6)],
      ],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.9, priceRank }, "x");
    expect(policy.route.edit).toBe("frontier");
    expect(policy.evidence.edit).toEqual({
      model: "groq:big",
      matchRate: 0.6,
      samples: 2,
    });
  });

  it("prefers a cheaper eligible model over a better expensive one", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
        "test",
        [model("groq:big", 5, 1), model("ollama:small", 2, 0.9)],
      ],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.9, priceRank }, "x");
    expect(policy.route.test).toBe("ollama:small");
  });

  it("emits the documented YAML shape", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
"read", [model("ollama:small", 2, 0.95)]],
      ["edit", [model("groq:big", 2, 0.2)]],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.9, priceRank }, "frontier/model");
    const parsed = parseYaml(policyToYaml(policy)) as Record<string, unknown>;

    expect(parsed.version).toBe(1);
    expect(parsed.frontier).toBe("frontier/model");
    expect(parsed.threshold).toBe(0.9);
    expect(parsed.route).toEqual({
      read: "ollama:small",
      edit: "frontier",
    });
    expect(parsed.evidence).toEqual({
      read: { model: "ollama:small", matchRate: 0.95, samples: 2 },
      edit: { model: "groq:big", matchRate: 0.2, samples: 2 },
    });
  });

  it("rounds evidence rates to four decimals", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
"read", [model("ollama:a", 3, 2 / 3)]],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.5, priceRank }, "x");
    expect(policy.evidence.read?.matchRate).toBe(0.6667);
  });

  it("writes the policy file", () => {
    const evidence = new Map<StepKind, ModelStats[]>([
      [
"read", [model("ollama:small", 2, 1)]],
    ]);
    const policy = selectRoutes(evidence, { threshold: 0.8, priceRank }, "x");
    const path = join(tempDir(), "downshift.policy.yaml");
    expect(writePolicyFile(policy, path)).toBe(path);
    expect(readFileSync(path, "utf8")).toContain("version: 1");
  });
});

describe("buildPolicy", () => {
  it("uses the report's session model as the frontier", () => {
    const policy = buildPolicy(
      {
        session: { model: "deepseek/deepseek-v4.1-flash" },
        records: [record("read", "ollama:small", 1), record("read", "ollama:small", 1)],
      },
      { threshold: 0.8, priceRank: () => 0 },
    );
    expect(policy.frontier).toBe("deepseek/deepseek-v4.1-flash");
    expect(policy.route.read).toBe("ollama:small");
  });

  it("accepts an explicit frontier override and rejects a blank one", () => {
    expect(
      buildPolicy(
        { session: { model: "" }, records: [] },
        { threshold: 0.8, frontier: "override/model", priceRank: () => 0 },
      ).frontier,
    ).toBe("override/model");

    expect(() =>
      buildPolicy(
        { session: { model: "  " }, records: [] },
        { threshold: 0.8, priceRank: () => 0 },
      ),
    ).toThrow(/frontier/);
  });
});

describe("price helpers", () => {
  const pricing: PricingTable = new Map([
    ["openai/gpt-oss-120b", price()],
    ["deepseek/deepseek-v4.1-flash", price({ id: "deepseek/deepseek-v4.1-flash" })],
  ]);
  const lookup = createPriceLookup(pricing);

  it("treats Ollama as local and free", () => {
    expect(lookup("ollama:gemma4:latest")).toEqual(ZERO_PRICE);
  });

  it("treats :free models as $0", () => {
    expect(lookup("openrouter:vendor/model:free")).toEqual(ZERO_PRICE);
  });

  it("looks up provider-prefixed and bare model ids", () => {
    expect(lookup("groq:openai/gpt-oss-120b")?.completionPerToken).toBe(
      3 / 1_000_000,
    );
    expect(lookup("deepseek/deepseek-v4.1-flash")?.promptPerToken).toBe(
      1 / 1_000_000,
    );
  });

  it("returns undefined for unknown models", () => {
    expect(lookup("unknown/model")).toBeUndefined();
    expect(lookup("")).toBeUndefined();
  });

  it("ranks local models cheapest and unknown models infinite", () => {
    const rank = listPriceRank(lookup);
    expect(rank("ollama:gemma4:latest")).toBe(0);
    expect(rank("groq:openai/gpt-oss-120b")).toBeCloseTo(4 / 1_000_000, 12);
    expect(rank("unknown/model")).toBe(Number.POSITIVE_INFINITY);
  });

  it("prices prompt, completion, cache and reasoning tokens", () => {
    const rates: TokenPrice = {
      promptPerToken: 10 / 1_000_000,
      completionPerToken: 20 / 1_000_000,
      cacheReadPerToken: 1 / 1_000_000,
      cacheWritePerToken: 12.5 / 1_000_000,
    };
    const cost = priceTokens(
      tokens({
        input: 1_000,
        output: 100,
        cacheRead: 2_000,
        cacheWrite: 200,
        reasoning: 50,
      }),
      rates,
    );
    // 0.01 + 0.002 + 0.002 + 0.0025 + 0.001
    expect(cost).toBeCloseTo(0.0175, 12);
  });
});

describe("computeProjectedSavings", () => {
  const frontier = "deepseek/deepseek-v4.1-flash";
  const cheap = "ollama:small";
  const frontierPrice: TokenPrice = {
    promptPerToken: 10 / 1_000_000,
    completionPerToken: 30 / 1_000_000,
    cacheReadPerToken: 1 / 1_000_000,
    cacheWritePerToken: 12.5 / 1_000_000,
  };
  const lookup = (modelRef: string): TokenPrice | undefined => {
    if (modelRef === frontier) return frontierPrice;
    if (modelRef === cheap) return ZERO_PRICE;
    if (modelRef === "groq:big") {
      return {
        promptPerToken: 2 / 1_000_000,
        completionPerToken: 6 / 1_000_000,
        cacheReadPerToken: 0,
        cacheWritePerToken: 2 / 1_000_000,
      };
    }
    return undefined;
  };

  const policy: Pick<RoutingPolicy, "frontier" | "route"> = {
    frontier,
    route: { read: cheap },
  };

  const steps = [
    { kind: "read" as const, tokens: tokens({ input: 1_000, output: 100 }) },
    { kind: "edit" as const, tokens: tokens({ input: 500, output: 50 }) },
  ];

  it("re-prices only downshifted kinds and totals before/after", () => {
    const savings = computeProjectedSavings(steps, policy, lookup);
    // Before: read 0.013 + edit 0.0065
    expect(savings.beforeUsd).toBeCloseTo(0.0195, 12);
    expect(savings.afterUsd).toBeCloseTo(0.0065, 12);
    expect(savings.savedUsd).toBeCloseTo(0.013, 12);
    expect(savings.savedPct).toBeCloseTo((0.013 / 0.0195) * 100, 10);
    expect(savings.kinds).toHaveLength(1);
    expect(savings.kinds[0]).toMatchObject({
      kind: "read",
      model: cheap,
      steps: 1,
    });
  });

  it("charges reasoning as output", () => {
    const savings = computeProjectedSavings(
      [{ kind: "read", tokens: tokens({ reasoning: 1_000 }) }],
      policy,
      lookup,
    );
    expect(savings.beforeUsd).toBeCloseTo(0.03, 12);
    expect(savings.afterUsd).toBe(0);
  });

  it("does not include frontier-routed kinds", () => {
    const savings = computeProjectedSavings(
      steps,
      { frontier, route: { read: "frontier", edit: "frontier" } },
      lookup,
    );
    expect(savings.kinds).toEqual([]);
    expect(savings.savedUsd).toBe(0);
  });

  it("prices a non-local route at its own rate", () => {
    const savings = computeProjectedSavings(
      [{ kind: "read", tokens: tokens({ input: 1_000, output: 100 }) }],
      { frontier, route: { read: "groq:big" } },
      lookup,
    );
    expect(savings.beforeUsd).toBeCloseTo(0.013, 12);
    expect(savings.afterUsd).toBeCloseTo(0.0026, 12);
    expect(savings.kinds[0]?.model).toBe("groq:big");
  });

  it("falls back to the frontier rate for an unknown route price", () => {
    const savings = computeProjectedSavings(
      steps,
      { frontier, route: { read: "unknown/model" } },
      lookup,
    );
    expect(savings.afterUsd).toBeCloseTo(savings.beforeUsd, 12);
    expect(savings.savedUsd).toBeCloseTo(0, 12);
  });

  it("reports zero when the frontier itself is unpriced", () => {
    const savings = computeProjectedSavings(
      steps,
      policy,
      () => undefined,
    );
    expect(savings.beforeUsd).toBe(0);
    expect(savings.afterUsd).toBe(0);
    expect(savings.savedPct).toBe(0);
  });

  it("handles an empty step list", () => {
    const savings = computeProjectedSavings([], policy, lookup);
    expect(savings).toEqual({
      beforeUsd: 0,
      afterUsd: 0,
      savedUsd: 0,
      savedPct: 0,
      kinds: [],
    });
  });
});