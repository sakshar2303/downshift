import { rmSync } from "node:fs";
import type { TokenPrice } from "../policy/policy.js";
import { priceTokens } from "../policy/policy.js";
import type { ModelChooser } from "./agent.js";
import {
  acceptsDownshift,
  hashTestFiles,
  runBenchAgent,
  runTaskTests,
  testFilesUnchanged,
  type BenchStepRecord,
} from "./agent.js";

export type BenchConfigId = "big" | "small" | "downshift";

export const BENCH_CONFIG_IDS: BenchConfigId[] = ["big", "small", "downshift"];

export interface BenchRunResult {
  run: number;
  passed: boolean;
  tampered: boolean;
  finished: boolean;
  steps: number;
  escalatedSteps: number;
  wallMs: number;
  listPriceUsd: number;
  testExitCode: number;
  error?: string;
}

export interface BenchConfigSummary {
  id: BenchConfigId;
  models: string[];
  passRate: number;
  meanSteps: number;
  meanListPriceUsd: number;
  escalationPct: number;
  meanWallMs: number;
  runs: BenchRunResult[];
}

export interface BenchReport {
  version: 1;
  generatedAt: string;
  task: string;
  runs: number;
  maxSteps: number;
  pricing: string;
  configs: BenchConfigSummary[];
  actualSpendUsd: 0;
}

export interface BenchSuiteOptions {
  taskDir: string;
  runs: number;
  bigModel: string;
  smallModel: string;
  configs?: BenchConfigId[];
  maxSteps?: number;
  lookup: (modelRef: string) => TokenPrice | undefined;
  onProgress?: (message: string) => void;
  onStep?: (config: BenchConfigId, run: number, record: BenchStepRecord) => void;
}

/** Sum the list-price cost of every model call in a run. */
export function priceRunSteps(
  steps: BenchStepRecord[],
  lookup: (modelRef: string) => TokenPrice | undefined,
): number {
  let total = 0;
  for (const step of steps) {
    for (const call of step.calls) {
      const price = lookup(call.modelRef);
      if (price !== undefined) total += priceTokens(call.tokens, price);
    }
  }
  return total;
}

/** Aggregate per-run results into the row shown in the bench table. */
export function summarizeConfig(
  id: BenchConfigId,
  models: string[],
  runs: BenchRunResult[],
): BenchConfigSummary {
  const count = runs.length;
  const totalSteps = runs.reduce((sum, run) => sum + run.steps, 0);
  const totalEscalated = runs.reduce(
    (sum, run) => sum + run.escalatedSteps,
    0,
  );

  return {
    id,
    models,
    passRate:
      count === 0 ? 0 : runs.filter((run) => run.passed).length / count,
    meanSteps: count === 0 ? 0 : totalSteps / count,
    meanListPriceUsd:
      count === 0
        ? 0
        : runs.reduce((sum, run) => sum + run.listPriceUsd, 0) / count,
    escalationPct: totalSteps === 0 ? 0 : (totalEscalated / totalSteps) * 100,
    meanWallMs:
      count === 0
        ? 0
        : runs.reduce((sum, run) => sum + run.wallMs, 0) / count,
    runs,
  };
}

function chooserFor(
  config: BenchConfigId,
  bigModel: string,
  smallModel: string,
): ModelChooser {
  return () => (config === "big" ? bigModel : smallModel);
}

function modelList(
  config: BenchConfigId,
  bigModel: string,
  smallModel: string,
): string[] {
  return config === "big" ? [bigModel] : config === "small" ? [smallModel] : [smallModel, bigModel];
}

/**
 * Run every configuration against a task, always on a fresh temp copy.
 *
 * A run passes only when `npm test` exits 0 and the test files are byte-for-byte
 * unchanged. Any agent error is recorded and the suite continues.
 */
export async function runBenchSuite(
  options: BenchSuiteOptions,
): Promise<BenchReport> {
  const configs = options.configs ?? BENCH_CONFIG_IDS;
  const hashesBefore = hashTestFiles(options.taskDir);
  const summaries: BenchConfigSummary[] = [];

  for (const config of configs) {
    const models = modelList(config, options.bigModel, options.smallModel);
    const results: BenchRunResult[] = [];

    for (let run = 1; run <= options.runs; run += 1) {
      options.onProgress?.(
        `[${config} ${run}/${options.runs}] starting (fresh temp copy + npm install)`,
      );

      const startedAt = Date.now();
      let result: BenchRunResult = {
        run,
        passed: false,
        tampered: false,
        finished: false,
        steps: 0,
        escalatedSteps: 0,
        wallMs: 0,
        listPriceUsd: 0,
        testExitCode: 1,
      };

      try {
        const agent = await runBenchAgent({
          taskDir: options.taskDir,
          chooseModel: chooserFor(config, options.bigModel, options.smallModel),
          ...(config === "downshift"
            ? {
                speculativeFallback: options.bigModel,
                acceptProposal: acceptsDownshift,
              }
            : {}),
          ...(options.maxSteps !== undefined
            ? { maxSteps: options.maxSteps }
            : {}),
          onStep: (record) => {
            options.onStep?.(config, run, record);
          },
        });

        const hashesAfter = hashTestFiles(agent.tempDir);
        const tampered = !testFilesUnchanged(hashesBefore, hashesAfter);
        const test = await runTaskTests(agent.tempDir);

        result = {
          run,
          passed: test.exitCode === 0 && !tampered,
          tampered,
          finished: agent.finished,
          steps: agent.steps.length,
          escalatedSteps: agent.escalatedSteps,
          wallMs: Date.now() - startedAt,
          listPriceUsd: priceRunSteps(agent.steps, options.lookup),
          testExitCode: test.exitCode,
        };

        rmSync(agent.tempDir, { recursive: true, force: true });
      } catch (error) {
        result = {
          ...result,
          wallMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      results.push(result);
      options.onProgress?.(
        `[${config} ${run}/${options.runs}] ${result.passed ? "PASS" : result.tampered ? "FAIL (tampered)" : "FAIL"} · ${result.steps} steps · $${result.listPriceUsd.toFixed(6)} · ${(result.wallMs / 1000).toFixed(1)}s${result.error !== undefined ? ` · ${result.error}` : ""}`,
      );
    }

    summaries.push(summarizeConfig(config, models, results));
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    task: options.taskDir,
    runs: options.runs,
    maxSteps: options.maxSteps ?? 30,
    pricing:
      "OpenRouter list prices; local Ollama and free tiers are $0. Dollar figures are list-price equivalents, not actual spend.",
    configs: summaries,
    actualSpendUsd: 0,
  };
}