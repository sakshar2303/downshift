import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  priceRunSteps,
  runBenchSuite,
  summarizeConfig,
  type BenchRunResult,
} from "../src/bench/bench.js";
import type { BenchStepRecord } from "../src/bench/agent.js";
import type { ChatResult } from "../src/providers/index.js";
import { ZERO_PRICE, type TokenPrice } from "../src/policy/policy.js";
import type { Tokens } from "../src/types.js";

function tokens(input: number, output: number): Tokens {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
}

function step(
  stepNumber: number,
  calls: Array<{ modelRef: string; tokens: Tokens }>,
  escalated = false,
): BenchStepRecord {
  return {
    step: stepNumber,
    modelRef: calls[calls.length - 1]?.modelRef ?? "unknown",
    tool: "read_file",
    kind: "read",
    tokens: calls[calls.length - 1]?.tokens ?? tokens(0, 0),
    latencyMs: 1,
    calls: calls.map((call) => ({ ...call, latencyMs: 1 })),
    escalated,
  };
}

function run(overrides: Partial<BenchRunResult> = {}): BenchRunResult {
  return {
    run: 1,
    passed: true,
    tampered: false,
    finished: true,
    steps: 5,
    escalatedSteps: 0,
    wallMs: 1_000,
    listPriceUsd: 0.001,
    testExitCode: 0,
    ...overrides,
  };
}

describe("priceRunSteps", () => {
  const prices: Record<string, TokenPrice> = {
    "groq:big": {
      promptPerToken: 1 / 1_000_000,
      completionPerToken: 3 / 1_000_000,
      cacheReadPerToken: 0,
      cacheWritePerToken: 0,
    },
    "ollama:small": ZERO_PRICE,
  };
  const lookup = (modelRef: string): TokenPrice | undefined => prices[modelRef];

  it("prices every call, including escalated small and big calls", () => {
    const steps = [
      step(1, [{ modelRef: "ollama:small", tokens: tokens(100, 10) }]),
      step(
        2,
        [
          { modelRef: "groq:big", tokens: tokens(1_000, 100) },
          { modelRef: "groq:big", tokens: tokens(2_000, 200) },
        ],
        true,
      ),
    ];
    // 0 + (1000 + 300 + 2000 + 600) / 1e6
    expect(priceRunSteps(steps, lookup)).toBeCloseTo(0.0039, 12);
  });

  it("prices local models at zero and ignores unknown prices", () => {
    const steps = [
      step(1, [
        { modelRef: "ollama:small", tokens: tokens(5_000, 500) },
        { modelRef: "unknown/model", tokens: tokens(5_000, 500) },
      ]),
    ];
    expect(priceRunSteps(steps, lookup)).toBe(0);
  });

  it("returns zero for no steps", () => {
    expect(priceRunSteps([], lookup)).toBe(0);
  });
});

describe("runBenchSuite", () => {
  it("keeps steps and list-price cost when a run aborts", async () => {
    const taskDir = mkdtempSync(join(tmpdir(), "downshift-bench-suite-"));
    mkdirSync(join(taskDir, "src"), { recursive: true });
    writeFileSync(join(taskDir, "TASK.md"), "Implement a.\n");

    const price: TokenPrice = {
      promptPerToken: 1 / 1_000_000,
      completionPerToken: 0,
      cacheReadPerToken: 0,
      cacheWritePerToken: 0,
    };
    let calls = 0;
    const providerError = Object.assign(new Error("provider exploded"), {
      status: 500,
    });
    const readReply: ChatResult = {
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "TASK.md" }),
            },
          },
        ],
      } as ChatResult["message"],
      usage: { prompt_tokens: 1_000, completion_tokens: 0, total_tokens: 1_000 },
      latencyMs: 1,
    };

    try {
      const report = await runBenchSuite({
        taskDir,
        runs: 1,
        configs: ["big"],
        bigModel: "groq:big",
        smallModel: "ollama:small",
        install: false,
        lookup: (modelRef) => (modelRef === "groq:big" ? price : undefined),
        chatFn: async () => {
          calls += 1;
          if (calls === 1) return readReply;
          throw providerError;
        },
      });

      const runResult = report.configs[0]?.runs[0];
      expect(runResult?.error).toContain("provider exploded");
      expect(runResult?.steps).toBe(1);
      expect(runResult?.listPriceUsd).toBeCloseTo(0.001, 12);
    } finally {
      rmSync(taskDir, { recursive: true, force: true });
    }
  });
});

describe("summarizeConfig", () => {
  it("aggregates pass rate, steps, price, escalation and wall time", () => {
    const summary = summarizeConfig("downshift", ["small", "big"], [
      run({ run: 1, passed: true, steps: 4, escalatedSteps: 1, listPriceUsd: 0.002, wallMs: 2_000 }),
      run({ run: 2, passed: false, steps: 6, escalatedSteps: 2, listPriceUsd: 0.004, wallMs: 4_000 }),
    ]);

    expect(summary.passRate).toBe(0.5);
    expect(summary.meanSteps).toBe(5);
    expect(summary.meanListPriceUsd).toBeCloseTo(0.003, 12);
    expect(summary.escalationPct).toBeCloseTo((3 / 10) * 100, 10);
    expect(summary.meanWallMs).toBe(3_000);
    expect(summary.models).toEqual(["small", "big"]);
  });

  it("counts tampered and errored runs as failures", () => {
    const summary = summarizeConfig("big", ["big"], [
      run({ passed: false, tampered: true }),
      run({ run: 2, passed: false, error: "rate limited", steps: 0 }),
    ]);
    expect(summary.passRate).toBe(0);
  });

  it("handles zero runs without dividing by zero", () => {
    expect(summarizeConfig("small", ["small"], [])).toMatchObject({
      passRate: 0,
      meanSteps: 0,
      meanListPriceUsd: 0,
      escalationPct: 0,
      meanWallMs: 0,
    });
  });
});