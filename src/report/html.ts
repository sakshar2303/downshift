import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { classifyStep } from "../classify/kinds.js";
import {
  PHASE_BY_KIND,
  stepFrameName,
  stepSpanValue,
} from "../flame/speedscope.js";
import type { Phase } from "../flame/speedscope.js";
import { displayPath } from "../paths.js";
import type { Session, Step, StepKind } from "../types.js";

const SVG_WIDTH = 1000;
const CHART_X = 170;
const CHART_WIDTH = SVG_WIDTH - CHART_X - 20;
const ROW_TOP = 26;
const ROW_HEIGHT = 40;
const ROW_GAP = 8;
const SVG_HEIGHT = ROW_TOP + 4 * (ROW_HEIGHT + ROW_GAP);

const KIND_COLORS: Record<StepKind, string> = {
  read: "#2563eb",
  search: "#0891b2",
  web: "#7c3aed",
  plan: "#a855f7",
  delegate: "#c084fc",
  edit: "#d97706",
  shell: "#ea580c",
  other: "#64748b",
  test: "#16a34a",
};

const PHASE_LABELS: Array<{ label: string; depth: number }> = [
  { label: "session", depth: 0 },
  { label: "phase", depth: 1 },
  { label: "kind", depth: 2 },
  { label: "step", depth: 3 },
];

export interface Block {
  id: string;
  depth: number;
  label: string;
  start: number;
  end: number;
  costUsd: number;
  tokens: number;
  kind?: StepKind;
  phase?: Phase;
}

interface KindTotal {
  kind: StepKind;
  steps: number;
  tokens: number;
  costUsd: number;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function tokensOf(step: Step): number {
  const tokens = step.tokens;
  return (
    tokens.input +
    tokens.output +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.reasoning
  );
}

/** Truncate a label so it is likely to fit inside a rendered block. */
function fitLabel(label: string, width: number): string {
  const maxChars = Math.floor((width - 10) / 6.5);
  if (maxChars < 4) return "";
  return label.length > maxChars ? `${label.slice(0, maxChars - 1)}…` : label;
}

function blockFill(block: Block): string {
  if (block.depth === 0) return "#1e40af";
  if (block.depth === 1) return "#334155";
  return KIND_COLORS[block.kind ?? "other"];
}

function blockRows(blocks: Block[], total: number): string {
  const layoutTotal = total > 0 ? total : 1;
  const sorted = [...blocks].sort((a, b) => a.depth - b.depth);

  return sorted
    .map((block) => {
      const y = ROW_TOP + block.depth * (ROW_HEIGHT + ROW_GAP);
      const x = CHART_X + (block.start / layoutTotal) * CHART_WIDTH;
      const width = ((block.end - block.start) / layoutTotal) * CHART_WIDTH;
      const label = fitLabel(block.label, width);
      const attrs = [
        `class="blk"`,
        `data-depth="${block.depth}"`,
        `data-start="${block.start}"`,
        `data-end="${block.end}"`,
        `data-label="${escapeHtml(block.label)}"`,
        `data-cost="${block.costUsd}"`,
        `data-tokens="${block.tokens}"`,
      ].join(" ");

      return [
        `<g ${attrs}>`,
        `<title>${escapeHtml(block.label)} · ${escapeHtml(formatUsd(block.costUsd))} · ${escapeHtml(formatCount(block.tokens))} tokens</title>`,
        `<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0, width).toFixed(2)}" height="${ROW_HEIGHT}" rx="3" fill="${blockFill(block)}" fill-opacity="${block.depth === 3 ? "0.82" : "1"}" stroke="#0b1120" stroke-width="1"/>`,
        label === ""
          ? ""
          : `<text x="${(x + 6).toFixed(2)}" y="${y + ROW_HEIGHT / 2 + 4}" fill="#f8fafc" font-size="11" pointer-events="none">${escapeHtml(label)}</text>`,
        `</g>`,
      ].join("");
    })
    .join("\n");
}

function buildBlocks(
  session: Session,
  totalCost: number,
  totalTokens: number,
): { blocks: Block[]; total: number } {
  let total = 0;
  for (const step of session.steps) total += stepSpanValue(step).value;

  const blocks: Block[] = [
    {
      id: "session",
      depth: 0,
      label: session.title ?? "(untitled)",
      start: 0,
      end: total,
      costUsd: totalCost,
      tokens: totalTokens,
    },
  ];

  let at = 0;
  let currentPhase: Phase | undefined;
  let currentKind: StepKind | undefined;
  let phaseBlock: Block | undefined;
  let kindBlock: Block | undefined;
  let phaseIndex = 0;
  let kindIndex = 0;

  for (const step of session.steps) {
    const kind = step.kind ?? classifyStep(step);
    const phase = PHASE_BY_KIND[kind];
    const span = stepSpanValue(step).value;
    const cost = step.costUsd ?? 0;
    const tokens = tokensOf(step);
    const frame = stepFrameName(step, session.cwd).name;

    if (phase !== currentPhase) {
      currentKind = undefined;
      kindBlock = undefined;
      phaseBlock = {
        id: `phase-${phaseIndex++}`,
        depth: 1,
        label: phase,
        start: at,
        end: at,
        costUsd: 0,
        tokens: 0,
        phase,
      };
      blocks.push(phaseBlock);
      currentPhase = phase;
    }

    if (kind !== currentKind) {
      kindBlock = {
        id: `phase-${phaseIndex - 1}-kind-${kindIndex++}`,
        depth: 2,
        label: kind,
        start: at,
        end: at,
        costUsd: 0,
        tokens: 0,
        kind,
        phase,
      };
      blocks.push(kindBlock);
      currentKind = kind;
    }

    blocks.push({
      id: `step-${step.index}`,
      depth: 3,
      label: frame,
      start: at,
      end: at + span,
      costUsd: cost,
      tokens,
      kind,
      phase,
    });

    at += span;
    if (phaseBlock !== undefined) {
      phaseBlock.end = at;
      phaseBlock.costUsd += cost;
      phaseBlock.tokens += tokens;
    }
    if (kindBlock !== undefined) {
      kindBlock.end = at;
      kindBlock.costUsd += cost;
      kindBlock.tokens += tokens;
    }
  }

  return { blocks, total };
}

function widestFirst<T>(
  items: T[],
  widthOf: (item: T) => number,
  labelOf: (item: T) => string,
): T[] {
  return [...items].sort(
    (a, b) => widthOf(b) - widthOf(a) || labelOf(a).localeCompare(labelOf(b)),
  );
}

interface StepGroup {
  label: string;
  width: number;
  costUsd: number;
  tokens: number;
  kind: StepKind;
  phase: Phase;
}

interface KindGroup {
  kind: StepKind;
  width: number;
  costUsd: number;
  tokens: number;
  steps: Map<string, StepGroup>;
}

interface PhaseGroup {
  phase: Phase;
  width: number;
  costUsd: number;
  tokens: number;
  kinds: Map<StepKind, KindGroup>;
}

/**
 * "Left heavy" layout: merge same-named blocks under the same parent, then pack
 * each parent's children widest first. Leaves are merged by step frame label.
 */
export function buildGroupedBlocks(session: Session): Block[] {
  const phases = new Map<Phase, PhaseGroup>();
  let total = 0;
  let totalCost = 0;
  let totalTokens = 0;

  for (const step of session.steps) {
    const kind = step.kind ?? classifyStep(step);
    const phase = PHASE_BY_KIND[kind];
    const span = stepSpanValue(step).value;
    const cost = step.costUsd ?? 0;
    const tokens = tokensOf(step);
    const label = stepFrameName(step, session.cwd).name;

    total += span;
    totalCost += cost;
    totalTokens += tokens;

    let phaseGroup = phases.get(phase);
    if (phaseGroup === undefined) {
      phaseGroup = {
        phase,
        width: 0,
        costUsd: 0,
        tokens: 0,
        kinds: new Map(),
      };
      phases.set(phase, phaseGroup);
    }
    phaseGroup.width += span;
    phaseGroup.costUsd += cost;
    phaseGroup.tokens += tokens;

    let kindGroup = phaseGroup.kinds.get(kind);
    if (kindGroup === undefined) {
      kindGroup = {
        kind,
        width: 0,
        costUsd: 0,
        tokens: 0,
        steps: new Map(),
      };
      phaseGroup.kinds.set(kind, kindGroup);
    }
    kindGroup.width += span;
    kindGroup.costUsd += cost;
    kindGroup.tokens += tokens;

    let stepGroup = kindGroup.steps.get(label);
    if (stepGroup === undefined) {
      stepGroup = { label, width: 0, costUsd: 0, tokens: 0, kind, phase };
      kindGroup.steps.set(label, stepGroup);
    }
    stepGroup.width += span;
    stepGroup.costUsd += cost;
    stepGroup.tokens += tokens;
  }

  const blocks: Block[] = [
    {
      id: "grouped-session",
      depth: 0,
      label: session.title ?? "(untitled)",
      start: 0,
      end: total,
      costUsd: totalCost,
      tokens: totalTokens,
    },
  ];

  let at = 0;
  let blockId = 0;
  for (const phaseGroup of widestFirst(
    [...phases.values()],
    (group) => group.width,
    (group) => group.phase,
  )) {
    const phaseStart = at;
    blocks.push({
      id: `grouped-${blockId++}`,
      depth: 1,
      label: phaseGroup.phase,
      start: phaseStart,
      end: phaseStart + phaseGroup.width,
      costUsd: phaseGroup.costUsd,
      tokens: phaseGroup.tokens,
      phase: phaseGroup.phase,
    });

    let phaseCursor = phaseStart;
    for (const kindGroup of widestFirst(
      [...phaseGroup.kinds.values()],
      (group) => group.width,
      (group) => group.kind,
    )) {
      const kindStart = phaseCursor;
      blocks.push({
        id: `grouped-${blockId++}`,
        depth: 2,
        label: kindGroup.kind,
        start: kindStart,
        end: kindStart + kindGroup.width,
        costUsd: kindGroup.costUsd,
        tokens: kindGroup.tokens,
        kind: kindGroup.kind,
        phase: phaseGroup.phase,
      });

      let kindCursor = kindStart;
      for (const stepGroup of widestFirst(
        [...kindGroup.steps.values()],
        (group) => group.width,
        (group) => group.label,
      )) {
        blocks.push({
          id: `grouped-${blockId++}`,
          depth: 3,
          label: stepGroup.label,
          start: kindCursor,
          end: kindCursor + stepGroup.width,
          costUsd: stepGroup.costUsd,
          tokens: stepGroup.tokens,
          kind: stepGroup.kind,
          phase: stepGroup.phase,
        });
        kindCursor += stepGroup.width;
      }

      phaseCursor += kindGroup.width;
    }

    at += phaseGroup.width;
  }

  return blocks;
}

function renderSvg(
  session: Session,
  timeline: Block[],
  grouped: Block[],
  total: number,
): string {
  const layoutTotal = total > 0 ? total : 1;
  const rowLabels = PHASE_LABELS.map(({ label, depth }) => {
    const y = ROW_TOP + depth * (ROW_HEIGHT + ROW_GAP) + ROW_HEIGHT / 2 + 4;
    return `<text x="16" y="${y}" fill="#94a3b8" font-size="12" font-weight="600">${label}</text>`;
  }).join("");

  return `<svg id="icicle" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" data-total="${layoutTotal}" role="img" aria-label="Cost flamegraph for ${escapeHtml(session.title ?? "session")}">
${rowLabels}
<g id="layer-timeline" style="display:none">
${blockRows(timeline, total)}
</g>
<g id="layer-grouped">
${blockRows(grouped, total)}
</g>
</svg>`;
}

const LEGEND_KINDS: StepKind[] = [
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

function renderLegend(): string {
  const items = LEGEND_KINDS.map(
    (kind) =>
      `<span class="legend-item"><span class="swatch" style="background:${KIND_COLORS[kind]}"></span>${kind}</span>`,
  ).join("\n");
  return `<div class="legend" aria-label="Step kind colors">
${items}
</div>`;
}

function renderCards(
  session: Session,
  totalCost: number,
  totalTokens: number,
  informativeShare: number,
): string {
  const models = [...new Set(session.steps.map((step) => step.model))]
    .filter((model) => model !== "")
    .join(", ");
  const cards: Array<[string, string]> = [
    ["Total cost", formatUsd(totalCost)],
    ["Tokens", formatCount(totalTokens)],
    ["Steps", formatCount(session.steps.length)],
    ["Model", models === "" ? "-" : models],
    ["Read + search + test", `${informativeShare.toFixed(1)}% of spend`],
  ];

  return cards
    .map(
      ([label, value]) =>
        `<div class="card"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div></div>`,
    )
    .join("\n");
}

function renderKindTable(kindTotals: KindTotal[], totalCost: number): string {
  const sorted = [...kindTotals].sort(
    (a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind),
  );
  const rows = sorted
    .map((entry) => {
      const share = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
      return `<tr><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(formatCount(entry.steps))}</td><td>${escapeHtml(formatCount(entry.tokens))}</td><td>${escapeHtml(formatUsd(entry.costUsd))}</td><td>${escapeHtml(`${share.toFixed(1)}%`)}</td></tr>`;
    })
    .join("\n");

  return `<table>
<thead><tr><th>Kind</th><th>Steps</th><th>Tokens</th><th>Cost</th><th>% spend</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
}

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0b1120;
  color: #e2e8f0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.5;
}
main { max-width: 1120px; margin: 0 auto; padding: 36px 24px 64px; }
.eyebrow {
  margin: 0 0 6px;
  color: #38bdf8;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
h1 { margin: 0; font-size: 28px; line-height: 1.2; color: #f8fafc; }
.meta { margin: 10px 0 0; color: #94a3b8; font-size: 13px; overflow-wrap: anywhere; }
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin: 24px 0;
}
.card {
  background: #111c33;
  border: 1px solid #1e293b;
  border-radius: 12px;
  padding: 14px 16px;
}
.card-label { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
.card-value { margin-top: 4px; color: #f8fafc; font-size: 20px; font-weight: 700; overflow-wrap: anywhere; }
.panel {
  margin-top: 22px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 14px;
  padding: 18px 18px 20px;
}
.panel h2 { margin: 0 0 4px; font-size: 16px; color: #f8fafc; }
.hint { margin: 0 0 14px; color: #94a3b8; font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0 0 12px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; color: #cbd5e1; font-size: 12px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.view-toggle {
  display: inline-flex;
  padding: 2px;
  margin: 0 0 14px;
  background: #111c33;
  border: 1px solid #1e293b;
  border-radius: 8px;
}
.view-toggle button {
  padding: 5px 10px;
  background: transparent;
  border: 0;
  border-radius: 6px;
  color: #94a3b8;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.view-toggle button.active { background: #1d4ed8; color: #f8fafc; }
svg { display: block; width: 100%; height: auto; }
.blk { cursor: pointer; }
.blk:hover rect { stroke: #f8fafc; stroke-width: 1.5; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th {
  color: #94a3b8;
  font-size: 11px;
  letter-spacing: 0.06em;
  text-align: left;
  text-transform: uppercase;
  border-bottom: 1px solid #1e293b;
  padding: 8px 10px;
}
td { padding: 9px 10px; border-bottom: 1px solid #16213a; }
td:nth-child(n + 2), th:nth-child(n + 2) { text-align: right; }
tbody tr:last-child td { border-bottom: 0; }
footer { margin-top: 28px; color: #64748b; font-size: 12px; overflow-wrap: anywhere; }
#tip {
  position: fixed;
  z-index: 10;
  display: none;
  max-width: 360px;
  padding: 9px 11px;
  background: #020617;
  border: 1px solid #334155;
  border-radius: 8px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  font-size: 12px;
}
.tip-label { color: #f8fafc; font-weight: 600; overflow-wrap: anywhere; }
.tip-meta { color: #94a3b8; margin-top: 3px; }
`;

const SCRIPT = `
(function () {
  var svg = document.getElementById("icicle");
  var tip = document.getElementById("tip");
  if (!svg || !tip) return;

  var layers = {
    timeline: document.getElementById("layer-timeline"),
    grouped: document.getElementById("layer-grouped"),
  };
  var buttons = Array.prototype.slice.call(
    document.querySelectorAll(".view-toggle button"),
  );
  if (!layers.timeline || !layers.grouped) return;

  var chartX = ${CHART_X};
  var chartWidth = ${CHART_WIDTH};
  var total = Number(svg.getAttribute("data-total")) || 1;
  var zoom = { start: 0, end: total };
  var mode = "grouped";

  function money(value) {
    if (value === 0) return "$0.00";
    if (value < 0.01) return "$" + value.toFixed(6);
    return "$" + value.toFixed(4);
  }

  function currentBlocks() {
    return Array.prototype.slice.call(layers[mode].querySelectorAll("g.blk"));
  }

  function apply() {
    var span = Math.max(1, zoom.end - zoom.start);
    currentBlocks().forEach(function (group) {
      var start = Number(group.getAttribute("data-start"));
      var end = Number(group.getAttribute("data-end"));
      var depth = Number(group.getAttribute("data-depth"));
      var from = Math.max(start, zoom.start);
      var to = Math.min(end, zoom.end);

      if (depth === 0) {
        from = 0;
        to = total;
      } else if (to <= from) {
        group.style.display = "none";
        return;
      }

      var x = chartX + ((from - zoom.start) / span) * chartWidth;
      var width = Math.max(0, ((to - from) / span) * chartWidth);
      group.style.display = "";
      var rect = group.querySelector("rect");
      var text = group.querySelector("text");
      rect.setAttribute("x", x.toFixed(2));
      rect.setAttribute("width", width.toFixed(2));
      if (text) {
        var label = group.getAttribute("data-label") || "";
        var maxChars = Math.floor((width - 10) / 6.5);
        if (maxChars < 4) {
          text.style.display = "none";
        } else {
          text.style.display = "";
          text.setAttribute("x", (x + 6).toFixed(2));
          text.textContent = label.length > maxChars
            ? label.slice(0, maxChars - 1) + "…"
            : label;
        }
      }
    });
  }

  svg.addEventListener("mousemove", function (event) {
    var target = event.target;
    var group = target && target.closest ? target.closest("g.blk") : null;
    if (!group) {
      tip.style.display = "none";
      return;
    }

    var label = document.createElement("div");
    label.className = "tip-label";
    label.textContent = group.getAttribute("data-label") || "";

    var meta = document.createElement("div");
    meta.className = "tip-meta";
    meta.textContent = money(Number(group.getAttribute("data-cost")) || 0) +
      " · " + (Number(group.getAttribute("data-tokens")) || 0).toLocaleString() +
      " tokens";

    tip.textContent = "";
    tip.appendChild(label);
    tip.appendChild(meta);
    tip.style.display = "block";
    tip.style.left = Math.min(window.innerWidth - 380, event.clientX + 14) + "px";
    tip.style.top = Math.min(window.innerHeight - 90, event.clientY + 14) + "px";
  });

  svg.addEventListener("mouseleave", function () {
    tip.style.display = "none";
  });

  svg.addEventListener("click", function (event) {
    var target = event.target;
    var group = target && target.closest ? target.closest("g.blk") : null;
    if (!group) return;

    var depth = Number(group.getAttribute("data-depth"));
    if (depth === 0) {
      zoom = { start: 0, end: total };
    } else {
      zoom = {
        start: Number(group.getAttribute("data-start")),
        end: Number(group.getAttribute("data-end")),
      };
    }
    apply();
  });

  function setMode(next) {
    mode = next;
    layers.timeline.style.display = next === "timeline" ? "" : "none";
    layers.grouped.style.display = next === "grouped" ? "" : "none";
    buttons.forEach(function (button) {
      var active = button.getAttribute("data-mode") === next;
      button.className = active ? "active" : "";
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    tip.style.display = "none";
    zoom = { start: 0, end: total };
    apply();
  }

  buttons.forEach(function (button) {
    button.addEventListener("click", function () {
      setMode(button.getAttribute("data-mode") || "grouped");
    });
  });

  setMode("grouped");
})();
`;

export function buildHtmlReport(session: Session): string {
  const title = session.title ?? "(untitled)";
  const totalCost = session.steps.reduce(
    (sum, step) => sum + (step.costUsd ?? 0),
    0,
  );
  const totalTokens = session.steps.reduce(
    (sum, step) => sum + tokensOf(step),
    0,
  );

  const kindTotals = new Map<StepKind, KindTotal>();
  for (const step of session.steps) {
    const kind = step.kind ?? classifyStep(step);
    const entry = kindTotals.get(kind) ?? {
      kind,
      steps: 0,
      tokens: 0,
      costUsd: 0,
    };
    entry.steps += 1;
    entry.tokens += tokensOf(step);
    entry.costUsd += step.costUsd ?? 0;
    kindTotals.set(kind, entry);
  }

  const informativeCost = [...kindTotals.values()]
    .filter(
      (entry) =>
        entry.kind === "read" ||
        entry.kind === "search" ||
        entry.kind === "test",
    )
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  const informativeShare = totalCost > 0 ? (informativeCost / totalCost) * 100 : 0;

  const { blocks: timelineBlocks, total } = buildBlocks(
    session,
    totalCost,
    totalTokens,
  );
  const groupedBlocks = buildGroupedBlocks(session);
  const path = displayPath(session.path, session.cwd);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>downshift · ${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<p class="eyebrow">downshift cost report</p>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(session.source)} · ${escapeHtml(path)}</p>
</header>

<section class="cards">
${renderCards(session, totalCost, totalTokens, informativeShare)}
</section>

<section class="panel">
<h2>Cost flamegraph</h2>
<p class="hint">Width is recomputed cost. Hover for details, click a block to zoom, click the top row to reset.</p>
${renderLegend()}
<div class="view-toggle" role="group" aria-label="Icicle view">
<button type="button" data-mode="timeline" aria-pressed="false">Timeline</button>
<button type="button" data-mode="grouped" aria-pressed="true" class="active">Grouped</button>
</div>
${renderSvg(session, timelineBlocks, groupedBlocks, total)}
</section>

<section class="panel">
<h2>Spend by step kind</h2>
${renderKindTable([...kindTotals.values()], totalCost)}
</section>

<footer>Generated by downshift. Width and cost use OpenRouter public list rates; unpriced steps fall back to token width.</footer>
</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Write the self-contained report and return the path written. */
export function writeHtmlReport(
  session: Session,
  outPath = "downshift-report/report.html",
): string {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buildHtmlReport(session), "utf8");
  return outPath;
}