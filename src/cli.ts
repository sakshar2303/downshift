import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { parseClaudeCodeTranscript } from "./ingest/claude-code.js";
import {
  discoverSessions,
  normalizeSource,
  resolveTarget,
} from "./ingest/discover.js";
import { loadOpencodeSession } from "./ingest/opencode.js";
import { classifyStep, summarizeShellCalls } from "./classify/kinds.js";
import {
  buildSpeedscope,
  stepFrameName,
  validateSpeedscope,
} from "./flame/speedscope.js";
import {
  applyPricing,
  loadModelOverrides,
} from "./pricing/model-map.js";
import { loadPricing } from "./pricing/openrouter.js";
import type { Session, StepKind, Tokens } from "./types.js";

const program = new Command();

function placeholder(name: string, description: string): Command {
  return new Command(name).description(description).action(() => {
    console.log(`${name}: not implemented yet`);
  });
}

function formatTimestamp(ms: number): string {
  if (ms <= 0) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function sumStepTokens(tokens: Tokens): number {
  return (
    tokens.input +
    tokens.output +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.reasoning
  );
}

function renderTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1
            ? cell
            : cell.padEnd(widths[index] ?? cell.length),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function loadSession(target: string): Session {
  const resolved = resolveTarget(target);
  const session =
    resolved.source === "opencode"
      ? loadOpencodeSession(resolved.path, resolved.id)
      : parseClaudeCodeTranscript(resolved.path);

  if (session === undefined) {
    throw new Error(`Session "${resolved.id}" was not found in ${resolved.path}`);
  }
  return session;
}

function sumTokens(steps: Session["steps"]): Tokens {
  const totals: Tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  for (const step of steps) {
    totals.input += step.tokens.input;
    totals.output += step.tokens.output;
    totals.cacheRead += step.tokens.cacheRead;
    totals.cacheWrite += step.tokens.cacheWrite;
    totals.reasoning += step.tokens.reasoning;
  }
  return totals;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}

program
  .name("downshift")
  .description(
    "Find where your AI agent can downshift to an open model — and prove it.",
  )
  .version("0.1.0");

program
  .command("sessions")
  .description("List the newest recorded agent sessions")
  .option("-s, --source <source>", "only show claude-code, opencode, or alan sessions")
  .action((options: { source?: string }) => {
    try {
      let filter: ReturnType<typeof normalizeSource>;
      if (options.source !== undefined) {
        filter = normalizeSource(options.source);
        if (filter === undefined) {
          throw new Error(
            `Unknown source "${options.source}". Expected alan, opencode, or claude-code.`,
          );
        }
      }

      const sessions = discoverSessions(filter);
      if (sessions.length === 0) {
        console.log(
          options.source === undefined
            ? "No recorded sessions found."
            : `No recorded ${options.source} sessions found.`,
        );
        return;
      }

      const shown = sessions.slice(0, 15);
      const rows: string[][] = [
        ["ID", "SOURCE", "STEPS", "TOKENS", "UPDATED", "TITLE"],
        ...shown.map((session) => [
          session.id,
          session.source,
          formatCount(session.stepCount),
          formatCount(session.totalTokens),
          formatTimestamp(session.updatedAt),
          session.title,
        ]),
      ];
      console.log(renderTable(rows));
      console.log(
        pc.dim(
          `\nShowing ${shown.length} of ${sessions.length} sessions. Use \`downshift analyze <target>\` to inspect one.`,
        ),
      );
    } catch (error) {
      fail(error);
    }
  });

program
  .command("analyze")
  .description("Price a session and show where its spend went")
  .argument("[target]", "a .jsonl transcript, an OpenCode session id, or latest", "latest")
  .action(async (target: string) => {
    try {
      const session = loadSession(target);
      const totals = sumTokens(session.steps);

      const pricing = await loadPricing();
      const overrides = loadModelOverrides();
      const recomputedCost = applyPricing(session.steps, {
        pricing,
        overrides,
      });

      for (const step of session.steps) {
        step.kind ??= classifyStep(step);
      }

      const models = [...new Set(session.steps.map((step) => step.model))]
        .filter((model) => model !== "")
        .join(", ");

      const recorded = session.steps
        .map((step) => step.recordedCostUsd)
        .filter((cost): cost is number => cost !== undefined);
      const recordedCost = recorded.reduce((sum, cost) => sum + cost, 0);

      console.log(`${pc.bold("Session")}  ${session.title ?? "(untitled)"}`);
      console.log(`${pc.bold("Source")}   ${session.source}`);
      console.log(`${pc.bold("Path")}     ${session.path}`);
      console.log(`${pc.bold("Model")}    ${models || "-"}`);
      console.log(`${pc.bold("Steps")}    ${formatCount(session.steps.length)}`);
      console.log(
        `${pc.bold("Tokens")}   input=${formatCount(totals.input)} output=${formatCount(totals.output)} cacheRead=${formatCount(totals.cacheRead)} cacheWrite=${formatCount(totals.cacheWrite)} reasoning=${formatCount(totals.reasoning)}`,
      );
      console.log(
        `${pc.bold("Cost")}     ${formatUsd(recomputedCost)} (recomputed at public list rates)`,
      );

      if (
        recorded.length > 0 &&
        recordedCost === 0 &&
        recomputedCost > 0
      ) {
        console.log(
          pc.yellow(
            "Recorded cost is $0 (Alan-hosted credits) — priced at public list rates.",
          ),
        );
      }

      if (session.steps.length === 0) return;

      interface KindSpend {
        steps: number;
        tokens: number;
        cost: number;
      }
      const byKind = new Map<StepKind, KindSpend>();
      for (const step of session.steps) {
        const kind = step.kind ?? "other";
        const bucket = byKind.get(kind) ?? { steps: 0, tokens: 0, cost: 0 };
        bucket.steps += 1;
        bucket.tokens += sumStepTokens(step.tokens);
        bucket.cost += step.costUsd ?? 0;
        byKind.set(kind, bucket);
      }

      const spendRows = [...byKind.entries()].sort(
        (a, b) => b[1].cost - a[1].cost || a[0].localeCompare(b[0]),
      );

      console.log(`\n${pc.bold("Spend by step kind")}`);
      const rows: string[][] = [["KIND", "STEPS", "TOKENS", "COST", "% SPEND"]];
      for (const [kind, bucket] of spendRows) {
        const share =
          recomputedCost > 0 ? (bucket.cost / recomputedCost) * 100 : 0;
        rows.push([
          kind,
          formatCount(bucket.steps),
          formatCount(bucket.tokens),
          formatUsd(bucket.cost),
          `${share.toFixed(1)}%`,
        ]);
      }
      console.log(renderTable(rows));

      const shellCalls = summarizeShellCalls(session.steps);
      if (shellCalls.total > 0) {
        console.log(
          pc.dim(
            `${shellCalls.informative} of ${shellCalls.total} bash calls were really reads/searches/tests`,
          ),
        );
      }

      console.log(`\n${pc.bold("First 10 steps")}`);
      const stepRows: string[][] = [["INDEX", "KIND", "MODEL", "TOOLS"]];
      for (const step of session.steps.slice(0, 10)) {
        stepRows.push([
          String(step.index),
          step.kind ?? "other",
          step.model || "-",
          step.tools.map((tool) => tool.name).join(", ") || "-",
        ]);
      }
      console.log(renderTable(stepRows));

      const speedscope = buildSpeedscope(session);
      const validation = validateSpeedscope(speedscope);
      if (!validation.valid) {
        throw new Error(
          `generated flamegraph failed validation: ${validation.errors.join("; ")}`,
        );
      }

      const reportDir = "downshift-report";
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(
        join(reportDir, "flame.speedscope.json"),
        JSON.stringify(speedscope, null, 2),
        "utf8",
      );
      writeFileSync(
        join(reportDir, "steps.json"),
        JSON.stringify(
          {
            session: {
              id: session.id,
              title: session.title ?? null,
              source: session.source,
              path: session.path,
            },
            steps: session.steps.map((step) => ({
              index: step.index,
              kind: step.kind ?? "other",
              frame: stepFrameName(step).name,
              model: step.model,
              provider: step.provider ?? null,
              startedAt: step.startedAt,
              tools: step.tools.map((tool) => tool.name),
              tokens: step.tokens,
              recordedCostUsd: step.recordedCostUsd ?? null,
              costUsd: step.costUsd ?? null,
            })),
          },
          null,
          2,
        ),
        "utf8",
      );

      console.log(
        `\nOpen https://www.speedscope.app and drag in ${reportDir}/flame.speedscope.json`,
      );
    } catch (error) {
      fail(error);
    }
  });

program.addCommand(placeholder("replay", "Replay recorded steps against an open model"));
program.addCommand(placeholder("policy", "Manage routing policies for agent steps"));
program.addCommand(placeholder("bench", "Run the benchmark suite for open models"));

program.parse();