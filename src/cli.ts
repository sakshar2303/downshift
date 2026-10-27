import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { displayPath } from "./paths.js";
import {
  buildSpeedscope,
  stepFrameName,
  validateSpeedscope,
} from "./flame/speedscope.js";
import { addReportSections, escapeHtml, writeHtmlReport } from "./report/html.js";
import { runDoctor } from "./providers/doctor.js";
import { configureProviders, parseModelRef } from "./providers/index.js";
import {
  rescoreReport,
  runReplay,
  writeReplayReport,
} from "./replay/run.js";
import {
  applyPricing,
  loadModelOverrides,
} from "./pricing/model-map.js";
import { loadPricing } from "./pricing/openrouter.js";
import {
  aggregateEvidence,
  buildPolicy,
  computeProjectedSavings,
  createPriceLookup,
  listPriceRank,
  writePolicyFile,
  type EvidenceByKind,
  type ModelStats,
  type ProjectedSavings,
} from "./policy/policy.js";
import type { ReplayReport } from "./replay/run.js";
import {
  BENCH_CONFIG_IDS,
  runBenchSuite,
  type BenchConfigId,
  type BenchReport,
} from "./bench/bench.js";
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

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  return `${(ms / 60_000).toFixed(1)} min`;
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

function readReplayReport(path: string): ReplayReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read replay report ${path}: ${error instanceof Error ? error.message : String(error)}. Run \`downshift replay latest\` first.`,
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Replay report ${path} is not a JSON object.`);
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.records)) {
    throw new Error(`Replay report ${path} has no records array.`);
  }
  if (
    typeof record.session !== "object" ||
    record.session === null ||
    typeof (record.session as Record<string, unknown>).model !== "string"
  ) {
    throw new Error(`Replay report ${path} has no session model.`);
  }
  return parsed as ReplayReport;
}

function loadReportSession(report: ReplayReport): Session | undefined {
  try {
    if (report.session.source === "opencode") {
      return loadOpencodeSession(report.session.path, report.session.id);
    }
    return parseClaudeCodeTranscript(report.session.path);
  } catch {
    return undefined;
  }
}

function modelColumns(evidence: EvidenceByKind): string[] {
  const models = new Set<string>();
  for (const stats of evidence.values()) {
    for (const entry of stats) models.add(entry.model);
  }
  return [...models].sort((a, b) => a.localeCompare(b));
}

function statsFor(stats: ModelStats[], model: string): ModelStats | undefined {
  return stats.find((entry) => entry.model === model);
}

function matchColor(rate: number | undefined): (text: string) => string {
  if (rate === undefined) return pc.dim;
  if (rate >= 0.8) return pc.green;
  if (rate >= 0.5) return pc.yellow;
  return pc.red;
}

function renderColorMatrix(
  rows: string[][],
  colors: Array<Array<(text: string) => string>>,
): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }

  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, index) => {
          const padded =
            index === row.length - 1
              ? cell
              : cell.padEnd(widths[index] ?? cell.length);
          const color = colors[rowIndex]?.[index] ?? ((text: string) => text);
          return color(padded);
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function renderMatrix(evidence: EvidenceByKind): string {
  const models = modelColumns(evidence);
  if (models.length === 0) return pc.dim("No scored replay records.");

  const rows: string[][] = [["KIND", ...models]];
  const colors: Array<Array<(text: string) => string>> = [
    rows[0]!.map(() => pc.bold),
  ];

  for (const [kind, stats] of evidence) {
    const row: string[] = [kind];
    const rowColors: Array<(text: string) => string> = [pc.cyan];
    for (const model of models) {
      const entry = statsFor(stats, model);
      row.push(entry === undefined ? "-" : `${(entry.matchRate * 100).toFixed(0)}%`);
      rowColors.push(matchColor(entry?.matchRate));
    }
    rows.push(row);
    colors.push(rowColors);
  }

  return renderColorMatrix(rows, colors);
}

function renderSavingsTable(savings: ProjectedSavings): string {
  if (savings.kinds.length === 0) return pc.dim("No kinds were downshifted.");
  const rows: string[][] = [
    ["KIND", "ROUTE", "STEPS", "BEFORE", "AFTER", "SAVED"],
  ];
  for (const entry of savings.kinds) {
    rows.push([
      entry.kind,
      entry.model,
      formatCount(entry.steps),
      formatUsd(entry.beforeUsd),
      formatUsd(entry.afterUsd),
      formatUsd(entry.savedUsd),
    ]);
  }
  return renderTable(rows);
}

function matrixBody(evidence: EvidenceByKind): string {
  const models = modelColumns(evidence);
  const header = ["Kind", ...models]
    .map((cell) => `<th>${escapeHtml(cell)}</th>`)
    .join("");
  const rows = [...evidence]
    .map(([kind, stats]) => {
      const cells = models
        .map((model) => {
          const entry = statsFor(stats, model);
          return `<td>${entry === undefined ? "-" : `${(entry.matchRate * 100).toFixed(0)}%`}</td>`;
        })
        .join("");
      return `<tr><td>${escapeHtml(kind)}</td>${cells}</tr>`;
    })
    .join("\n");
  return `<table><thead><tr>${header}</tr></thead><tbody>\n${rows}\n</tbody></table>
<p class="hint">Match rate is the share of replayed steps scoring at least 80% against the recorded action.</p>`;
}

function savingsBody(savings: ProjectedSavings): string {
  const cells: Array<[string, string]> = [
    ["Before", formatUsd(savings.beforeUsd)],
    ["After", formatUsd(savings.afterUsd)],
    ["Saved", `${savings.savedPct.toFixed(1)}%`],
  ];
  const cards = cells
    .map(
      ([label, value]) =>
        `<div><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`,
    )
    .join("\n");
  const rows = savings.kinds
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(entry.model)}</td><td>${escapeHtml(formatCount(entry.steps))}</td><td>${escapeHtml(formatUsd(entry.beforeUsd))}</td><td>${escapeHtml(formatUsd(entry.afterUsd))}</td></tr>`,
    )
    .join("\n");
  return `<div class="savings">\n${cards}\n</div>
<table><thead><tr><th>Kind</th><th>Route</th><th>Steps</th><th>Before</th><th>After</th></tr></thead><tbody>
${rows}
</tbody></table>
<p class="note">Projected at list prices — actual spend $0.</p>`;
}

function parseBenchConfigs(value: string): BenchConfigId[] {
  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const configs: BenchConfigId[] = [];
  for (const entry of requested) {
    if (!BENCH_CONFIG_IDS.includes(entry as BenchConfigId)) {
      throw new Error(
        `Unknown bench config "${entry}". Expected big, small, or downshift.`,
      );
    }
    const id = entry as BenchConfigId;
    if (!configs.includes(id)) configs.push(id);
  }
  if (configs.length === 0) {
    throw new Error("At least one --configs entry is required.");
  }
  return configs;
}

function bar(
  label: string,
  percent: number,
  value: string,
): string {
  const width = Math.max(0, Math.min(100, percent));
  return `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%"></div></div><span class="bar-value">${escapeHtml(value)}</span></div>`;
}

function proofBody(report: BenchReport): string {
  const maxPrice = Math.max(
    0.000000001,
    ...report.configs.map((config) => config.meanListPriceUsd),
  );
  const passBars = report.configs
    .map((config) =>
      bar(
        config.id,
        config.passRate * 100,
        `${(config.passRate * 100).toFixed(0)}%`,
      ),
    )
    .join("\n");
  const priceBars = report.configs
    .map((config) =>
      bar(
        config.id,
        (config.meanListPriceUsd / maxPrice) * 100,
        formatUsd(config.meanListPriceUsd),
      ),
    )
    .join("\n");
  const escalationBars = report.configs
    .map((config) =>
      bar(
        config.id,
        config.escalationPct,
        `${config.escalationPct.toFixed(0)}%`,
      ),
    )
    .join("\n");

  return `<h3>Pass rate</h3>
${passBars}
<h3>Mean list price per run</h3>
${priceBars}
<h3>Escalation rate</h3>
${escalationBars}
<p class="hint">${escapeHtml(String(report.runs))} runs per config on ${escapeHtml(report.task)}; max ${escapeHtml(String(report.maxSteps))} steps. Success requires \`npm test\` to exit 0 with unchanged test files.</p>
<p class="note">Actual spend: $0 (local + free tiers).</p>`;
}

function renderBenchTable(report: BenchReport): string {
  const rows: string[][] = [
    ["CONFIG", "PASS RATE", "MEAN STEPS", "MEAN LIST $", "ESCALATION", "WALL TIME"],
  ];
  for (const config of report.configs) {
    rows.push([
      config.id,
      `${(config.passRate * 100).toFixed(0)}%`,
      config.meanSteps.toFixed(1),
      formatUsd(config.meanListPriceUsd),
      `${config.escalationPct.toFixed(0)}%`,
      formatDuration(config.meanWallMs),
    ]);
  }
  return renderTable(rows);
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

function openInBrowser(path: string): void {
  const absolute = resolve(path);
  let command = "xdg-open";
  let args = [absolute];
  if (process.platform === "darwin") {
    command = "open";
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", absolute];
  }

  execFile(command, args, (error) => {
    if (error !== null) {
      console.error(pc.yellow(`Could not open ${absolute}: ${error.message}`));
    }
  });
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
  .version("0.1.0")
  .option(
    "--allow-paid",
    "allow non-:free OpenRouter models (paid use is off by default)",
  )
  .hook("preAction", (thisCommand) => {
    configureProviders({
      allowPaid: thisCommand.opts().allowPaid === true,
    });
  });

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
  .option("--open", "open the HTML report in the browser")
  .option("-t, --title <title>", "override the session title in the report")
  .action(async (target: string, options: { open?: boolean; title?: string }) => {
    try {
      const session = loadSession(target);
      if (options.title !== undefined && options.title.trim() !== "") {
        session.title = options.title.trim();
      }
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
      console.log(
        `${pc.bold("Path")}     ${displayPath(session.path, session.cwd)}`,
      );
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
              frame: stepFrameName(step, session.cwd).name,
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

      const reportPath = join(reportDir, "report.html");
      writeHtmlReport(session, reportPath);

      console.log(
        `\nOpen https://www.speedscope.app and drag in ${reportDir}/flame.speedscope.json`,
      );
      console.log(`Report: ${reportPath}`);
      if (options.open === true) openInBrowser(reportPath);
    } catch (error) {
      fail(error);
    }
  });

program
  .command("replay")
  .description("Replay sampled session steps on free open models")
  .argument(
    "[target]",
    "a .jsonl transcript, an OpenCode session id, or latest",
    "latest",
  )
  .option(
    "--models <models>",
    "comma-separated model refs",
    "ollama:gemma4:latest,groq:openai/gpt-oss-120b",
  )
  .option("--per-kind <n>", "max replayable steps per kind", "4")
  .option("--seed <n>", "sampling seed", "42")
  .action(
    async (
      target: string,
      options: { models: string; perKind: string; seed: string },
    ) => {
      try {
        const perKind = Number.parseInt(options.perKind, 10);
        if (!Number.isInteger(perKind) || perKind < 0) {
          throw new Error(`Invalid --per-kind "${options.perKind}".`);
        }
        const seed = Number.parseInt(options.seed, 10);
        if (!Number.isInteger(seed)) {
          throw new Error(`Invalid --seed "${options.seed}".`);
        }
        const models = options.models
          .split(",")
          .map((model) => model.trim())
          .filter((model) => model !== "");
        if (models.length === 0) {
          throw new Error("At least one model is required.");
        }
        for (const model of models) parseModelRef(model);

        const session = loadSession(target);
        let wroteProgress = false;

        const report = await runReplay(
          session,
          { models, perKind, seed },
          {
            onPlan(plan) {
              console.log(
                `Replay plan: ${formatCount(plan.totalCalls)} calls across ${plan.models.length} model(s), ${formatCount(plan.cachedCalls)} cached`,
              );
              for (const model of plan.models) {
                console.log(
                  `  ${model.modelRef} (${model.provider}): ${formatCount(model.calls)} calls${model.cached > 0 ? `, ${formatCount(model.cached)} cached` : ""}, ~${formatDuration(model.estimatedMs)}`,
                );
              }
              console.log(`Estimated time: ~${formatDuration(plan.estimatedMs)}`);
            },
            onProgress(record, completed, total) {
              const line = `[${completed}/${total}] step ${record.stepIndex} ${record.kind} → ${record.modelRef}${record.cached === true ? " (cached)" : ""}${record.error !== undefined ? " (error)" : ""}`;
              if (process.stdout.isTTY) {
                process.stdout.write(`\r\x1b[K${line}`);
              } else {
                console.log(line);
              }
              wroteProgress = true;
            },
          },
        );

        if (wroteProgress && process.stdout.isTTY) process.stdout.write("\n");

        const path = writeReplayReport(report);
        const cached = report.records.filter((record) => record.cached === true).length;
        const failed = report.records.filter((record) => record.error !== undefined).length;
        console.log(
          `Replayed ${formatCount(report.records.length)} calls (${formatCount(cached)} cached, ${formatCount(failed)} failed)`,
        );
        console.log(`Wrote ${path}`);
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command("doctor")
  .description("Check Ollama, Groq and OpenRouter free-tier setup")
  .action(async () => {
    try {
      const checks = await runDoctor();
      for (const check of checks) {
        const mark = check.ok ? pc.green("✓") : pc.red("✗");
        const detail = check.detail === "" ? "" : pc.dim(` — ${check.detail}`);
        console.log(`${mark} ${check.name}${detail}`);
      }
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    } catch (error) {
      fail(error);
    }
  });

program
  .command("policy")
  .description("Turn replay scores into a routing policy and projected savings")
  .argument(
    "[report]",
    "a replay report path, or latest for the newest replay run",
    "downshift-report/replays.json",
  )
  .option("--threshold <n>", "minimum match rate to downshift a kind", "0.9")
  .option("--out <path>", "policy output path", "downshift.policy.yaml")
  .option("--html <path>", "HTML report to augment", "downshift-report/report.html")
  .option(
    "--rescore",
    "recompute action-match scores from the stored replay responses",
  )
  .action(
    async (
      reportPath: string,
      options: {
        threshold: string;
        out: string;
        html: string;
        rescore?: boolean;
      },
    ) => {
      try {
        const threshold = Number.parseFloat(options.threshold);
        if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
          throw new Error(
            `Invalid --threshold "${options.threshold}". Expected a number between 0 and 1.`,
          );
        }

        const resolvedReportPath =
          reportPath === "latest" ? "downshift-report/replays.json" : reportPath;
        const report = readReplayReport(resolvedReportPath);
        const session = loadReportSession(report);

        if (options.rescore === true) {
          if (session === undefined) {
            throw new Error(
              `Could not load the session referenced by ${resolvedReportPath} (${report.session.path}); cannot rescore.`,
            );
          }
          const summary = rescoreReport(report, session);
          writeReplayReport(report, resolvedReportPath);
          const kept =
            summary.kept > 0
              ? `, ${formatCount(summary.kept)} plan scores kept`
              : "";
          const skipped =
            summary.skipped > 0
              ? `, ${formatCount(summary.skipped)} skipped`
              : "";
          console.log(
            pc.bold(
              `Rescored ${formatCount(summary.rescored)} tool records${kept}${skipped}`,
            ),
          );
        }

        const scored = report.records.filter(
          (record) =>
            record.error === undefined && typeof record.score === "number",
        );
        if (scored.length === 0) {
          throw new Error(
            `No scored replay records in ${resolvedReportPath}. Run \`downshift replay latest\` again to attach action-match scores.`,
          );
        }
        const unscored = report.records.length - scored.length;
        if (unscored > 0) {
          console.log(
            pc.yellow(
              `${unscored} of ${report.records.length} replay records have no score and were ignored.`,
            ),
          );
        }

        const pricing = await loadPricing();
        const lookup = createPriceLookup(pricing);
        const policy = buildPolicy(report, {
          threshold,
          priceRank: listPriceRank(lookup),
        });
        const evidence = aggregateEvidence(report.records);
        const policyPath = writePolicyFile(policy, options.out);

        console.log(pc.bold("Replay matrix (match rate)"));
        console.log(renderMatrix(evidence));
        console.log(
          pc.dim(
            "green >= 80%  yellow >= 50%  red < 50%  dim = no samples",
          ),
        );
        console.log(
          pc.dim(
            `frontier: ${policy.frontier}  threshold: ${(threshold * 100).toFixed(0)}%  cheapest model with >= 2 samples wins`,
          ),
        );

        console.log(`\n${pc.bold("Route")}`);
        const routeRows: string[][] = [["KIND", "ROUTE", "MATCH", "SAMPLES"]];
        for (const [kind, entry] of Object.entries(policy.evidence)) {
          const route = policy.route[kind] ?? "frontier";
          routeRows.push([
            kind,
            route,
            `${(entry.matchRate * 100).toFixed(1)}%`,
            formatCount(entry.samples),
          ]);
        }
        console.log(renderTable(routeRows));
        console.log(`\nWrote ${policyPath}`);

        let savings: ProjectedSavings | undefined;
        if (session === undefined) {
          console.log(
            pc.yellow(
              "Could not load the replayed session; skipping projected savings.",
            ),
          );
        } else {
          for (const step of session.steps) step.kind ??= classifyStep(step);
          savings = computeProjectedSavings(
            session.steps.map((step) => ({
              kind: step.kind ?? "other",
              tokens: step.tokens,
            })),
            policy,
            lookup,
          );

          console.log(`\n${pc.bold("Projected savings")}`);
          console.log(
            `Before ${formatUsd(savings.beforeUsd)}  After ${formatUsd(savings.afterUsd)}  Saved ${savings.savedPct.toFixed(1)}%`,
          );
          console.log(renderSavingsTable(savings));
          console.log(
            pc.yellow(
              "projected at list prices — actual spend $0 (local + free tiers)",
            ),
          );
        }

        const sections = [
          {
            id: "replay-matrix",
            title: "Replay matrix",
            body: matrixBody(evidence),
          },
        ];
        if (savings !== undefined) {
          sections.push({
            id: "projected-savings",
            title: "Projected savings",
            body: savingsBody(savings),
          });
        }
        if (addReportSections(options.html, sections)) {
          console.log(`Updated ${options.html}`);
        } else {
          console.log(
            pc.dim(`No HTML report at ${options.html}; skipped report sections.`),
          );
        }
      } catch (error) {
        fail(error);
      }
    },
  );

program
  .command("bench")
  .description("Run big, small and speculative-downshift agents on a task")
  .option("--task <path>", "benchmark task folder", "bench/tasks/csv-export")
  .option("--runs <n>", "runs per config", "2")
  .option("--big <model>", "big model ref", "groq:openai/gpt-oss-120b")
  .option("--small <model>", "small model ref", "ollama:gemma4:latest")
  .option("--max-steps <n>", "maximum agent steps per run", "30")
  .option("--configs <list>", "comma-separated big,small,downshift", "big,small,downshift")
  .option("--out <path>", "bench JSON output", "downshift-report/bench.json")
  .option("--html <path>", "HTML report to augment", "downshift-report/report.html")
  .action(
    async (options: {
      task: string;
      runs: string;
      big: string;
      small: string;
      maxSteps: string;
      configs: string;
      out: string;
      html: string;
    }) => {
      try {
        const runs = Number.parseInt(options.runs, 10);
        if (!Number.isInteger(runs) || runs < 1) {
          throw new Error(`Invalid --runs "${options.runs}".`);
        }
        const maxSteps = Number.parseInt(options.maxSteps, 10);
        if (!Number.isInteger(maxSteps) || maxSteps < 1) {
          throw new Error(`Invalid --max-steps "${options.maxSteps}".`);
        }
        parseModelRef(options.big);
        parseModelRef(options.small);
        const configs = parseBenchConfigs(options.configs);
        const pricing = await loadPricing();
        const lookup = createPriceLookup(pricing);

        console.log(pc.bold("Downshift benchmark"));
        console.log(
          `${options.task} · ${runs} run(s) per config · max ${maxSteps} steps`,
        );
        console.log(
          pc.dim(
            "Groq's free tier is token-bucketed; long pauses between steps are the rate limiter, not a hang.",
          ),
        );

        const report = await runBenchSuite({
          taskDir: options.task,
          runs,
          bigModel: options.big,
          smallModel: options.small,
          configs,
          maxSteps,
          lookup,
          onProgress: (message) => console.log(message),
          onStep: (config, run, record) => {
            const escalation = record.escalated ? pc.yellow(" escalated") : "";
            console.log(
              pc.dim(
                `[${config} ${run}] step ${record.step} ${record.tool} (${record.kind}) → ${record.modelRef}${escalation} · ${(record.latencyMs / 1000).toFixed(1)}s`,
              ),
            );
          },
        });

        mkdirSync(dirname(options.out), { recursive: true });
        writeFileSync(options.out, JSON.stringify(report, null, 2), "utf8");

        console.log(`\n${pc.bold("Results")}`);
        console.log(renderBenchTable(report));
        console.log(
          pc.green("Actual spend: $0 (local + free tiers)"),
        );
        console.log(
          pc.dim(
            "Dollar figures are OpenRouter list-price equivalents for the same token counts; local Ollama is $0.",
          ),
        );
        console.log(`Wrote ${options.out}`);

        if (
          addReportSections(options.html, [
            {
              id: "proof",
              title: "Proof",
              body: proofBody(report),
            },
          ])
        ) {
          console.log(`Updated ${options.html}`);
        } else {
          console.log(
            pc.dim(`No HTML report at ${options.html}; skipped Proof section.`),
          );
        }
      } catch (error) {
        fail(error);
      }
    },
  );

program.parse();