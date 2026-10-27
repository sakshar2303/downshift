import type { BenchConfigSummary, BenchReport } from "../bench/bench.js";
import { escapeHtml, formatUsd } from "./html.js";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1_000))}s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function bar(label: string, percent: number, value: string): string {
  const width = Math.max(0, Math.min(100, percent));
  return `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(1)}%"></div></div><span class="bar-value">${escapeHtml(value)}</span></div>`;
}

function cheapestPass(config: BenchConfigSummary | undefined): number | undefined {
  const prices = (config?.runs ?? [])
    .filter((run) => run.passed)
    .map((run) => run.listPriceUsd);
  return prices.length === 0 ? undefined : Math.min(...prices);
}

/**
 * One sentence comparing the cheapest passing big run with the cheapest
 * passing downshift run, or undefined when either config never passed.
 */
export function cheapestPassComparison(report: BenchReport): string | undefined {
  const big = cheapestPass(report.configs.find((config) => config.id === "big"));
  const routed = cheapestPass(
    report.configs.find((config) => config.id === "downshift"),
  );
  if (big === undefined || routed === undefined || big <= 0) return undefined;
  const saved = ((big - routed) / big) * 100;
  const verdict =
    saved >= 0
      ? `${saved.toFixed(1)}% cheaper`
      : `${Math.abs(saved).toFixed(1)}% more expensive`;
  return `Cheapest passing run: downshift ${formatUsd(routed)} vs big ${formatUsd(big)}, ${verdict} at list price, with the tests passing in both.`;
}

function runsTable(report: BenchReport): string {
  const rows = report.configs
    .flatMap((config) =>
      config.runs.map((run) => {
        const result = run.passed
          ? "pass"
          : `fail${run.error === undefined ? "" : `: ${run.error}`}`;
        return `<tr><td>${escapeHtml(config.id)}</td><td>${escapeHtml(String(run.run))}</td><td class="${run.passed ? "ok" : "bad"}">${escapeHtml(result)}</td><td>${escapeHtml(String(run.steps))}</td><td>${escapeHtml(String(run.escalatedSteps))}</td><td>${escapeHtml(formatUsd(run.listPriceUsd))}</td><td>${escapeHtml(formatDuration(run.wallMs))}</td></tr>`;
      }),
    )
    .join("\n");
  return `<div class="table-wrap"><table>
<thead><tr><th>Config</th><th>Run</th><th>Result</th><th>Steps</th><th>Escalated</th><th>List price</th><th>Time</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

/** Body of the report's Proof section, built from a bench report. */
export function proofBody(report: BenchReport): string {
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
  const comparison = cheapestPassComparison(report);

  return `${comparison === undefined ? "" : `<p class="lead">${escapeHtml(comparison)}</p>\n`}<h3>Pass rate</h3>
${passBars}
<h3>Mean list price per run</h3>
${priceBars}
<h3>Escalation rate</h3>
${escalationBars}
<h3>Every run</h3>
${runsTable(report)}
<p class="hint">${escapeHtml(String(report.runs))} runs per config on ${escapeHtml(report.task)}; max ${escapeHtml(String(report.maxSteps))} steps. Success requires \`npm test\` to exit 0 with unchanged test files. Means include failed runs.</p>
<p class="note">Actual spend: $0 (local + free tiers).</p>`;
}
