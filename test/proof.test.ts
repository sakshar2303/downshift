import { describe, expect, it } from "vitest";
import type { BenchReport } from "../src/bench/bench.js";
import { cheapestPassComparison, proofBody } from "../src/report/proof.js";

function run(runNo: number, passed: boolean, listPriceUsd: number, error?: string) {
  return {
    run: runNo,
    passed,
    tampered: false,
    finished: passed,
    steps: 9,
    escalatedSteps: 3,
    wallMs: 90_000,
    listPriceUsd,
    testExitCode: passed ? 0 : 1,
    ...(error === undefined ? {} : { error }),
  };
}

function report(): BenchReport {
  const config = (id: "big" | "small" | "downshift", runs: ReturnType<typeof run>[]) => ({
    id,
    models: ["m"],
    passRate: runs.filter((r) => r.passed).length / runs.length,
    meanSteps: 9,
    meanListPriceUsd: runs.reduce((sum, r) => sum + r.listPriceUsd, 0) / runs.length,
    escalationPct: 0,
    meanWallMs: 90_000,
    runs,
  });
  return {
    version: 1,
    generatedAt: "2026-10-27T00:00:00.000Z",
    task: "bench/tasks/csv-export",
    runs: 2,
    maxSteps: 30,
    pricing: "openrouter",
    configs: [
      config("big", [run(1, true, 0.002311), run(2, true, 0.002254)]),
      config("downshift", [run(1, true, 0.001494), run(2, false, 0, "<b>timed out</b>")]),
    ],
    actualSpendUsd: 0,
  };
}

describe("proofBody", () => {
  it("compares the cheapest passing runs", () => {
    expect(cheapestPassComparison(report())).toBe(
      "Cheapest passing run: downshift $0.001494 vs big $0.002254, 33.7% cheaper at list price, with the tests passing in both.",
    );
  });

  it("skips the comparison when downshift never passed", () => {
    const r = report();
    r.configs[1]!.runs = [run(1, false, 0)];
    expect(cheapestPassComparison(r)).toBeUndefined();
  });

  it("lists every run and escapes run errors", () => {
    const html = proofBody(report());
    expect(html).toContain("<h3>Every run</h3>");
    expect(html.match(/<tr><td>/g)).toHaveLength(4);
    expect(html).toContain("fail: &lt;b&gt;timed out&lt;/b&gt;");
    expect(html).not.toContain("<b>timed out</b>");
  });
});
