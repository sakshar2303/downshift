import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Muted inks that read on the paper background. Light fills get dark labels.
const KIND_COLORS: Record<StepKind, string> = {
  read: "#3b6ea5",
  search: "#2f8f8a",
  web: "#6b5fb5",
  plan: "#8c4f86",
  delegate: "#b98bb3",
  edit: "#d39a2c",
  shell: "#c8502f",
  other: "#9a958a",
  test: "#5a8f3d",
};

const DARK_LABEL_KINDS = new Set<StepKind>(["edit", "delegate", "other"]);
const INK = "#1a1917";
const PAPER = "#f2efe7";

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
  if (block.depth === 0) return INK;
  if (block.depth === 1) return "#d9d3c4";
  return KIND_COLORS[block.kind ?? "other"];
}

function blockLabelFill(block: Block): string {
  if (block.depth === 0) return PAPER;
  if (block.depth === 1) return INK;
  return DARK_LABEL_KINDS.has(block.kind ?? "other") ? INK : "#fbfaf6";
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
        `data-kind="${block.depth >= 2 ? (block.kind ?? "other") : ""}"`,
      ].join(" ");

      return [
        `<g ${attrs}>`,
        `<title>${escapeHtml(block.label)} · ${escapeHtml(formatUsd(block.costUsd))} · ${escapeHtml(formatCount(block.tokens))} tokens</title>`,
        `<rect x="${x.toFixed(2)}" y="${y}" width="${Math.max(0, width).toFixed(2)}" height="${ROW_HEIGHT}" rx="2" fill="${blockFill(block)}" fill-opacity="${block.depth === 3 ? "0.86" : "1"}" stroke="${PAPER}" stroke-width="1"/>`,
        label === ""
          ? ""
          : `<text x="${(x + 6).toFixed(2)}" y="${y + ROW_HEIGHT / 2 + 4}" fill="${blockLabelFill(block)}" font-size="11" pointer-events="none">${escapeHtml(label)}</text>`,
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
    return `<text x="16" y="${y}" fill="#7d786e" font-size="12" font-weight="600" letter-spacing="0.04em">${label}</text>`;
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
      `<button type="button" class="legend-item" data-kind="${kind}" aria-pressed="false"><span class="swatch" style="background:${KIND_COLORS[kind]}"></span><span>${kind}</span></button>`,
  ).join("\n");
  return `<div class="legend" role="group" aria-label="Step kinds: click one to highlight it">
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
      ([label, value], index) =>
        `<div class="card${index === 0 ? " card-lead" : ""}${label === "Model" ? " card-text" : ""}"><div class="card-label">${escapeHtml(label)}</div><div class="card-value">${escapeHtml(value)}</div></div>`,
    )
    .join("\n");
}

function renderKindTable(kindTotals: KindTotal[], totalCost: number): string {
  const sorted = [...kindTotals].sort(
    (a, b) => b.costUsd - a.costUsd || a.kind.localeCompare(b.kind),
  );
  const maxCost = Math.max(0, ...sorted.map((entry) => entry.costUsd));
  const rows = sorted
    .map((entry) => {
      const share = totalCost > 0 ? (entry.costUsd / totalCost) * 100 : 0;
      const barWidth = maxCost > 0 ? (entry.costUsd / maxCost) * 100 : 0;
      return `<tr data-kind="${escapeHtml(entry.kind)}"><td>${escapeHtml(entry.kind)}</td><td>${escapeHtml(formatCount(entry.steps))}</td><td>${escapeHtml(formatCount(entry.tokens))}</td><td>${escapeHtml(formatUsd(entry.costUsd))}</td><td><span class="share" aria-hidden="true"><i style="--w:${barWidth.toFixed(1)}%;background:${KIND_COLORS[entry.kind]}"></i></span><span class="pct">${escapeHtml(`${share.toFixed(1)}%`)}</span></td></tr>`;
    })
    .join("\n");

  return `<div class="table-wrap"><table class="kind-table">
<thead><tr><th>Kind</th><th>Steps</th><th>Tokens</th><th>Cost</th><th>% spend</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

const STYLE = `
:root {
  color-scheme: light;
  --paper: #f2efe7;
  --paper-2: #ebe7dc;
  --ink: #1a1917;
  --ink-2: #4a4741;
  --mute: #7d786e;
  --rule: #d6d0c2;
  --accent: #c8502f;
  --serif: "Iowan Old Style", "Charter", "Palatino Linotype", Georgia, serif;
  --sans: -apple-system, "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
::selection { background: #f0c9b8; }
#progress {
  position: fixed;
  z-index: 30;
  top: 0;
  left: 0;
  height: 2px;
  width: 100%;
  background: var(--accent);
  transform: scaleX(0);
  transform-origin: 0 50%;
}
.topbar {
  position: sticky;
  z-index: 20;
  top: 0;
  background: rgba(242, 239, 231, 0.92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid transparent;
  transition: border-color 0.2s;
}
.topbar.scrolled { border-bottom-color: var(--rule); }
.topbar-in {
  max-width: 1120px;
  margin: 0 auto;
  padding: 12px 24px;
  display: flex;
  align-items: center;
  gap: 18px;
}
.brand { display: inline-flex; align-items: center; gap: 9px; font: 600 14px var(--mono); }
.brand i { width: 9px; height: 9px; border-radius: 2px; background: var(--accent); }
.toc { margin-left: auto; display: flex; gap: 4px; flex-wrap: wrap; }
.toc a {
  color: var(--mute);
  text-decoration: none;
  font-size: 12.5px;
  padding: 4px 9px;
  border-radius: 999px;
  transition: color 0.2s, background 0.2s;
}
.toc a:hover { color: var(--ink); }
.toc a.on { color: var(--ink); background: var(--paper-2); }
.toc a b { font: 500 11px var(--mono); color: var(--mute); margin-right: 5px; }
main { max-width: 1120px; margin: 0 auto; padding: 44px 24px 80px; counter-reset: sec; }
.eyebrow {
  margin: 0 0 10px;
  color: var(--accent);
  font: 600 12px var(--mono);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  max-width: 820px;
  font: 600 clamp(34px, 5vw, 54px) / 1.04 var(--serif);
  letter-spacing: -0.015em;
}
.meta { margin: 14px 0 0; color: var(--mute); font: 13px var(--mono); overflow-wrap: anywhere; }
.cards {
  display: grid;
  grid-template-columns: 1.5fr repeat(4, 1fr);
  margin: 38px 0 8px;
  border-top: 2px solid var(--ink);
  border-bottom: 1px solid var(--rule);
}
.card { padding: 16px 18px 18px; border-left: 1px solid var(--rule); min-width: 0; }
.card:first-child { border-left: 0; padding-left: 0; }
.card-label { color: var(--mute); font-size: 12px; letter-spacing: 0.02em; }
.card-value {
  margin-top: 6px;
  font: 600 24px / 1.15 var(--mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
  overflow-wrap: anywhere;
}
.card-lead .card-value { font-size: 40px; color: var(--accent); }
.card-text .card-value { font: 500 15px / 1.35 var(--mono); letter-spacing: 0; }
.panel { margin-top: 64px; counter-increment: sec; scroll-margin-top: 70px; }
.panel h2 {
  margin: 0 0 6px;
  font: 600 28px / 1.15 var(--serif);
  letter-spacing: -0.01em;
  display: flex;
  align-items: baseline;
  gap: 14px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--rule);
}
.panel h2::before {
  content: counter(sec, decimal-leading-zero);
  font: 500 13px var(--mono);
  color: var(--accent);
  letter-spacing: 0;
}
.panel h3 { margin: 22px 0 8px; font: 600 13px var(--sans); color: var(--ink-2); }
.hint { margin: 10px 0 16px; color: var(--mute); font-size: 13.5px; max-width: 720px; }
.flame-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 20px; margin: 4px 0 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px; }
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 10px 4px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-2);
  font: 12.5px var(--sans);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, opacity 0.2s;
}
.legend-item:hover { background: var(--paper-2); }
.legend-item[aria-pressed="true"] { border-color: var(--ink); background: #fbfaf6; color: var(--ink); }
.legend.has-focus .legend-item[aria-pressed="false"] { opacity: 0.45; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.view-toggle {
  display: inline-flex;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--rule);
  border-radius: 7px;
}
.view-toggle button {
  padding: 4px 12px;
  background: transparent;
  border: 0;
  border-radius: 5px;
  color: var(--mute);
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
}
.view-toggle button.active { background: var(--ink); color: var(--paper); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 26px; margin: 0 0 6px; font: 12.5px var(--mono); color: var(--mute); }
.crumbs button { padding: 2px 6px; border: 0; border-radius: 4px; background: transparent; color: var(--ink-2); font: inherit; cursor: pointer; }
.crumbs button:hover { background: var(--paper-2); color: var(--ink); }
.crumbs .sep { color: var(--rule); }
.crumbs .cur { color: var(--ink); padding: 2px 6px; }
.chart { background: #fbfaf6; border: 1px solid var(--rule); border-radius: 4px; padding: 6px 4px 2px; }
svg { display: block; width: 100%; height: auto; }
.blk { cursor: zoom-in; transition: opacity 0.25s; }
.blk[data-depth="0"] { cursor: zoom-out; }
.blk:hover rect { stroke: var(--ink); stroke-width: 1.5; }
.blk.dim { opacity: 0.14; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th {
  color: var(--mute);
  font: 500 12px var(--sans);
  text-align: left;
  border-bottom: 1px solid var(--ink);
  padding: 10px 12px;
  white-space: nowrap;
}
.kind-table th { cursor: pointer; user-select: none; }
.kind-table th:hover { color: var(--ink); }
th.asc::after { content: " ↑"; color: var(--accent); }
th.desc::after { content: " ↓"; color: var(--accent); }
td { padding: 11px 12px; border-bottom: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
td:nth-child(n + 2) { font-family: var(--mono); font-size: 13px; }
td:nth-child(n + 2), th:nth-child(n + 2) { text-align: right; }
tbody tr { transition: background 0.15s; }
tbody tr:hover { background: var(--paper-2); }
.kind-table tbody tr { cursor: pointer; }
.kind-table td:first-child { font-weight: 600; }
.share { display: inline-block; width: 90px; height: 6px; margin-right: 12px; vertical-align: 1px; background: var(--paper-2); border-radius: 3px; overflow: hidden; }
.pct { display: inline-block; min-width: 3.4em; }
.share i { display: block; height: 100%; width: var(--w); border-radius: 3px; transition: width 0.9s cubic-bezier(0.2, 0.7, 0.1, 1); }
footer { margin-top: 72px; padding-top: 16px; border-top: 1px solid var(--rule); color: var(--mute); font-size: 12.5px; overflow-wrap: anywhere; }
.bar-row { display: grid; grid-template-columns: 140px 1fr 100px; gap: 12px; align-items: center; margin: 8px 0; font-size: 13px; }
.bar-track { height: 10px; background: var(--paper-2); border-radius: 5px; overflow: hidden; }
.bar-fill { height: 100%; background: var(--ink); border-radius: 5px; transition: transform 0.9s cubic-bezier(0.2, 0.7, 0.1, 1); transform-origin: 0 50%; }
.bar-value { font-family: var(--mono); color: var(--ink-2); text-align: right; }
.savings { display: flex; flex-wrap: wrap; margin: 8px 0 18px; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); }
.savings div { min-width: 150px; }
.savings > div { padding: 12px 18px 14px; border-left: 1px solid var(--rule); }
.savings > div:first-child { border-left: 0; padding-left: 0; }
.savings .label { color: var(--mute); font-size: 12px; }
.savings .value { font: 600 26px var(--mono); letter-spacing: -0.02em; }
.note { color: var(--accent); font-size: 13px; margin: 12px 0 0; }
td.heat { transition: background 0.6s; }
#tip {
  position: fixed;
  z-index: 40;
  display: none;
  min-width: 220px;
  max-width: 360px;
  padding: 10px 12px;
  background: #fbfaf6;
  color: var(--ink);
  border: 1px solid var(--ink);
  border-radius: 3px;
  box-shadow: 4px 4px 0 rgba(26, 25, 23, 0.12);
  pointer-events: none;
  font-size: 12.5px;
}
.tip-label { font-weight: 600; overflow-wrap: anywhere; display: flex; gap: 8px; align-items: center; }
.tip-grid { display: grid; grid-template-columns: auto 1fr; gap: 2px 14px; margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--rule); font-family: var(--mono); font-size: 12px; }
.tip-grid span:nth-child(odd) { color: var(--mute); font-family: var(--sans); }
.tip-grid span:nth-child(even) { text-align: right; }
.motion .reveal { opacity: 0; transform: translateY(18px); transition: opacity 0.7s ease, transform 0.7s cubic-bezier(0.2, 0.7, 0.1, 1); }
.motion .reveal.in { opacity: 1; transform: none; }
.motion .panel tbody tr { opacity: 0; transform: translateX(-8px); transition: opacity 0.45s ease, transform 0.45s ease, background 0.15s; }
.motion .panel.in tbody tr { opacity: 1; transform: none; }
.motion .panel:not(.in) .share i { width: 0; }
.motion .panel:not(.in) .bar-fill { transform: scaleX(0); }
.motion #icicle .blk rect { transform: scaleX(0); transform-box: fill-box; transform-origin: 0 50%; transition: transform 0.9s cubic-bezier(0.2, 0.7, 0.1, 1); }
.motion #icicle .blk text { opacity: 0; transition: opacity 0.4s ease 0.7s; }
.motion #icicle .blk[data-depth="1"] rect { transition-delay: 0.1s; }
.motion #icicle .blk[data-depth="2"] rect { transition-delay: 0.2s; }
.motion #icicle .blk[data-depth="3"] rect { transition-delay: 0.3s; }
.motion .in #icicle .blk rect { transform: none; }
.motion .in #icicle .blk text { opacity: 1; }
@media (max-width: 820px) {
  .cards { grid-template-columns: 1fr 1fr; }
  .card { border-top: 1px solid var(--rule); }
  .card-lead { grid-column: 1 / -1; border-top: 0; }
  .card:nth-child(2), .card:nth-child(4) { border-left: 0; padding-left: 0; }
  .card-value { font-size: 19px; }
  .card-lead .card-value { font-size: 34px; }
  .toc { display: none; }
  .view-toggle { margin-left: 0; }
  .share { display: none; }
  .pct { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .motion .reveal, .motion .panel tbody tr, .motion #icicle .blk rect, .motion #icicle .blk text { opacity: 1; transform: none; transition: none; }
}
`;

const SCRIPT = `
(function () {
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var observe = "IntersectionObserver" in window;
  if (observe && !reduce) root.className += " motion";

  function each(list, fn) { Array.prototype.forEach.call(list, fn); }
  function money(value) {
    if (value === 0) return "$0.00";
    if (value < 0.01) return "$" + value.toFixed(6);
    return "$" + value.toFixed(4);
  }

  // Number the sections, build the section index, reveal panels on scroll.
  var panels = document.querySelectorAll("main > .panel");
  var toc = document.getElementById("toc");
  var links = [];
  each(panels, function (panel, i) {
    panel.classList.add("reveal");
    if (!panel.id) panel.id = "s" + (i + 1);
    var h2 = panel.querySelector("h2");
    if (!toc || !h2) return;
    var a = document.createElement("a");
    a.href = "#" + panel.id;
    var n = document.createElement("b");
    n.textContent = String(i + 1).padStart(2, "0");
    a.appendChild(n);
    a.appendChild(document.createTextNode(h2.textContent));
    toc.appendChild(a);
    links.push(a);
    each(panel.querySelectorAll("tbody tr"), function (row, r) {
      row.style.transitionDelay = Math.min(r * 45, 600) + "ms";
    });
  });

  function countUp(el) {
    var text = el.textContent;
    var match = text.match(/^([^0-9]*)([0-9][0-9,]*(?:\\.[0-9]+)?)(.*)$/);
    if (!match || reduce) return;
    var target = Number(match[2].replace(/,/g, ""));
    var decimals = (match[2].split(".")[1] || "").length;
    var commas = match[2].indexOf(",") >= 0;
    var t0 = performance.now();
    function frame(now) {
      var p = Math.min(1, (now - t0) / 1100);
      var v = target * (1 - Math.pow(1 - p, 3));
      var s = commas
        ? Math.round(v).toLocaleString("en-US")
        : v.toFixed(decimals);
      el.textContent = p < 1 ? match[1] + s + match[3] : text;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  var revealed = [];
  each(document.querySelectorAll(".reveal"), function (el) { revealed.push(el); });
  if (observe) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        if (entry.target.classList.contains("cards")) {
          each(entry.target.querySelectorAll(".card:not(.card-text) .card-value"), countUp);
        }
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12 });
    revealed.forEach(function (el) { io.observe(el); });

    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.className = a.getAttribute("href") === "#" + entry.target.id ? "on" : "";
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    each(panels, function (panel) { spy.observe(panel); });
  } else {
    revealed.forEach(function (el) { el.classList.add("in"); });
  }

  var bar = document.getElementById("progress");
  var top = document.querySelector(".topbar");
  function onScroll() {
    var max = document.documentElement.scrollHeight - window.innerHeight;
    if (bar) bar.style.transform = "scaleX(" + (max > 0 ? window.scrollY / max : 0) + ")";
    if (top) top.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Heat-tint percentage cells in extra sections (replay matrix).
  each(document.querySelectorAll("[data-downshift-section] td"), function (td) {
    var m = td.textContent.trim().match(/^([0-9.]+)%$/);
    if (!m) return;
    var v = Math.max(0, Math.min(100, Number(m[1]))) / 100;
    td.classList.add("heat");
    td.style.background = "rgba(90, 143, 61, " + (0.06 + v * 0.5).toFixed(3) + ")";
  });

  // Sortable kind table; clicking a row highlights that kind in the chart.
  each(document.querySelectorAll(".kind-table"), function (table) {
    var heads = table.querySelectorAll("th");
    var body = table.querySelector("tbody");
    each(heads, function (th, col) {
      th.addEventListener("click", function () {
        var dir = th.classList.contains("desc") ? "asc" : "desc";
        each(heads, function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var rows = Array.prototype.slice.call(body.rows);
        rows.sort(function (a, b) {
          var x = a.cells[col].textContent, y = b.cells[col].textContent;
          var nx = Number(x.replace(/[^0-9.]/g, "")), ny = Number(y.replace(/[^0-9.]/g, ""));
          var c = col === 0 ? x.localeCompare(y) : nx - ny;
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (row) { row.style.transitionDelay = "0ms"; body.appendChild(row); });
      });
    });
    each(body.rows, function (row) {
      row.addEventListener("click", function () {
        setFocus(row.getAttribute("data-kind"));
        var chart = document.getElementById("icicle");
        if (chart) chart.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
      });
    });
  });

  // Flamegraph: tooltip, animated zoom, breadcrumb, kind focus.
  var svg = document.getElementById("icicle");
  var tip = document.getElementById("tip");
  var crumbs = document.getElementById("crumbs");
  var legend = document.querySelector(".legend");
  var focusKind = "";

  function setFocus(kind) {
    focusKind = kind === focusKind ? "" : (kind || "");
    if (legend) {
      legend.classList.toggle("has-focus", focusKind !== "");
      each(legend.querySelectorAll(".legend-item"), function (item) {
        item.setAttribute("aria-pressed", item.getAttribute("data-kind") === focusKind ? "true" : "false");
      });
    }
    if (!svg) return;
    each(svg.querySelectorAll("g.blk"), function (g) {
      var k = g.getAttribute("data-kind");
      g.classList.toggle("dim", focusKind !== "" && k !== "" && k !== focusKind);
    });
  }
  if (legend) {
    each(legend.querySelectorAll(".legend-item"), function (item) {
      item.addEventListener("click", function () { setFocus(item.getAttribute("data-kind")); });
    });
  }

  if (!svg || !tip) return;
  var layers = {
    timeline: document.getElementById("layer-timeline"),
    grouped: document.getElementById("layer-grouped"),
  };
  var buttons = Array.prototype.slice.call(document.querySelectorAll(".view-toggle button"));
  if (!layers.timeline || !layers.grouped) return;

  var chartX = ${CHART_X};
  var chartWidth = ${CHART_WIDTH};
  var total = Number(svg.getAttribute("data-total")) || 1;
  var zoom = { start: 0, end: total };
  var mode = "grouped";
  var anim = 0;

  function currentBlocks() {
    return Array.prototype.slice.call(layers[mode].querySelectorAll("g.blk"));
  }

  function setLabel(group, x, width) {
    var text = group.querySelector("text");
    if (!text) return;
    var label = group.getAttribute("data-label") || "";
    var maxChars = Math.floor((width - 10) / 6.5);
    if (maxChars < 4) {
      text.style.display = "none";
      return;
    }
    text.style.display = "";
    text.setAttribute("x", (x + 6).toFixed(2));
    text.textContent = label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label;
  }

  function target(group) {
    var depth = Number(group.getAttribute("data-depth"));
    var start = Number(group.getAttribute("data-start"));
    var end = Number(group.getAttribute("data-end"));
    if (depth === 0) return { x: chartX, w: chartWidth };
    var span = Math.max(1, zoom.end - zoom.start);
    var from = Math.min(Math.max(start, zoom.start), zoom.end);
    var to = Math.min(Math.max(end, zoom.start), zoom.end);
    return {
      x: chartX + ((from - zoom.start) / span) * chartWidth,
      w: Math.max(0, ((to - from) / span) * chartWidth),
    };
  }

  function apply(animate) {
    var blocks = currentBlocks().map(function (group) {
      var rect = group.querySelector("rect");
      return {
        group: group,
        rect: rect,
        x0: Number(rect.getAttribute("x")),
        w0: Number(rect.getAttribute("width")),
        to: target(group),
      };
    });
    cancelAnimationFrame(anim);
    var t0 = performance.now();
    var duration = animate && !reduce ? 420 : 0;
    function frame(now) {
      var p = duration ? Math.min(1, (now - t0) / duration) : 1;
      var e = 1 - Math.pow(1 - p, 3);
      blocks.forEach(function (b) {
        var x = b.x0 + (b.to.x - b.x0) * e;
        var w = b.w0 + (b.to.w - b.w0) * e;
        b.rect.setAttribute("x", x.toFixed(2));
        b.rect.setAttribute("width", w.toFixed(2));
        if (p === 1 || w > 60) setLabel(b.group, x, w);
      });
      if (p < 1) anim = requestAnimationFrame(frame);
    }
    if (duration) anim = requestAnimationFrame(frame); else frame(t0);
  }

  function renderCrumbs(group) {
    if (!crumbs) return;
    crumbs.textContent = "";
    var home = document.createElement("button");
    home.type = "button";
    home.textContent = "all steps";
    home.addEventListener("click", function () { zoomTo(null); });
    crumbs.appendChild(home);
    if (!group) return;
    var start = Number(group.getAttribute("data-start"));
    var end = Number(group.getAttribute("data-end"));
    var depth = Number(group.getAttribute("data-depth"));
    currentBlocks().forEach(function (g) {
      var d = Number(g.getAttribute("data-depth"));
      if (d < 1 || d > depth) return;
      if (Number(g.getAttribute("data-start")) > start || Number(g.getAttribute("data-end")) < end) return;
      var sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      crumbs.appendChild(sep);
      var item = document.createElement(d === depth ? "span" : "button");
      if (d === depth) item.className = "cur";
      else {
        item.type = "button";
        item.addEventListener("click", function () { zoomTo(g); });
      }
      item.textContent = g.getAttribute("data-label") || "";
      crumbs.appendChild(item);
    });
  }

  function zoomTo(group) {
    var depth = group ? Number(group.getAttribute("data-depth")) : 0;
    zoom = depth === 0
      ? { start: 0, end: total }
      : { start: Number(group.getAttribute("data-start")), end: Number(group.getAttribute("data-end")) };
    renderCrumbs(depth === 0 ? null : group);
    apply(true);
  }

  function row(grid, name, value) {
    var a = document.createElement("span");
    a.textContent = name;
    var b = document.createElement("span");
    b.textContent = value;
    grid.appendChild(a);
    grid.appendChild(b);
  }

  svg.addEventListener("mousemove", function (event) {
    var target = event.target;
    var group = target && target.closest ? target.closest("g.blk") : null;
    if (!group) {
      tip.style.display = "none";
      return;
    }
    var cost = Number(group.getAttribute("data-cost")) || 0;
    var share = (Number(group.getAttribute("data-end")) - Number(group.getAttribute("data-start"))) / total * 100;
    var label = document.createElement("div");
    label.className = "tip-label";
    var rect = group.querySelector("rect");
    var sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = rect ? rect.getAttribute("fill") : "";
    label.appendChild(sw);
    label.appendChild(document.createTextNode(group.getAttribute("data-label") || ""));
    var grid = document.createElement("div");
    grid.className = "tip-grid";
    row(grid, "cost", money(cost));
    row(grid, "tokens", (Number(group.getAttribute("data-tokens")) || 0).toLocaleString("en-US"));
    row(grid, "share of session", share.toFixed(1) + "%");
    tip.textContent = "";
    tip.appendChild(label);
    tip.appendChild(grid);
    tip.style.display = "block";
    tip.style.left = Math.min(window.innerWidth - 380, event.clientX + 16) + "px";
    tip.style.top = Math.min(window.innerHeight - 120, event.clientY + 16) + "px";
  });

  svg.addEventListener("mouseleave", function () {
    tip.style.display = "none";
  });

  svg.addEventListener("click", function (event) {
    var target = event.target;
    var group = target && target.closest ? target.closest("g.blk") : null;
    if (group) zoomTo(group);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      zoomTo(null);
      setFocus("");
    }
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
    renderCrumbs(null);
    apply(false);
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
<div id="progress" aria-hidden="true"></div>
<nav class="topbar" aria-label="Report sections">
<div class="topbar-in"><span class="brand"><i></i>downshift</span><div class="toc" id="toc"></div></div>
</nav>
<main>
<header class="reveal">
<p class="eyebrow">downshift cost report</p>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(session.source)} · ${escapeHtml(path)}</p>
</header>

<section class="cards reveal">
${renderCards(session, totalCost, totalTokens, informativeShare)}
</section>

<section class="panel">
<h2>Cost flamegraph</h2>
<p class="hint">Width is recomputed cost. Hover a block for its numbers, click it to zoom in, click the top row or press Esc to zoom back out. Pick a kind below to highlight it.</p>
<div class="flame-tools">
${renderLegend()}
<div class="view-toggle" role="group" aria-label="Icicle view">
<button type="button" data-mode="timeline" aria-pressed="false">Timeline</button>
<button type="button" data-mode="grouped" aria-pressed="true" class="active">Grouped</button>
</div>
</div>
<div class="crumbs" id="crumbs" aria-live="polite"></div>
<div class="chart">
${renderSvg(session, timelineBlocks, groupedBlocks, total)}
</div>
</section>

<section class="panel">
<h2>Spend by step kind</h2>
<p class="hint">Click a column to sort. Click a row to highlight that kind in the flamegraph.</p>
${renderKindTable([...kindTotals.values()], totalCost)}
</section>

<!-- downshift:extra-sections -->
<footer>Generated by downshift. Width and cost use OpenRouter public list rates; unpriced steps fall back to token width.</footer>
</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export interface ReportSection {
  /** Stable id, used to replace a previous version of the same section. */
  id: string;
  title: string;
  /** Trusted HTML fragment; the caller must escape dynamic text. */
  body: string;
}

/** Render one extra report panel. */
export function renderReportSection(section: ReportSection): string {
  return `<section class="panel" data-downshift-section="${escapeHtml(section.id)}">
<h2>${escapeHtml(section.title)}</h2>
${section.body}
</section>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add or replace sections in an existing self-contained report. Returns false
 * when the report has not been generated yet.
 */
export function addReportSections(
  outPath: string,
  sections: ReportSection[],
): boolean {
  if (!existsSync(outPath)) return false;

  let html = readFileSync(outPath, "utf8");
  for (const section of sections) {
    const pattern = new RegExp(
      `\\n?<section class="panel" data-downshift-section="${escapeRegExp(section.id)}">[\\s\\S]*?</section>`,
      "g",
    );
    html = html.replace(pattern, "");
  }

  const fragment = sections.map(renderReportSection).join("\n");
  const marker = "<!-- downshift:extra-sections -->";
  if (html.includes(marker)) {
    html = html.replace(marker, `${fragment}\n${marker}`);
  } else if (html.includes("</main>")) {
    html = html.replace("</main>", `${fragment}\n</main>`);
  } else {
    return false;
  }

  writeFileSync(outPath, html, "utf8");
  return true;
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