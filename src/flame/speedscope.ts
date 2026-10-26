import packageJson from "../../package.json" with { type: "json" };
import {
  classifyCommandSegment,
  classifyStep,
  classifyToolCall,
  splitCommandSegments,
} from "../classify/kinds.js";
import { displayPath } from "../paths.js";
import type { Session, Step, StepKind, ToolCall } from "../types.js";

const MAX_FRAME_CHARS = 80;

export type Phase = "explore" | "plan" | "implement" | "verify";

/** Steps are grouped into contiguous phases so the flamegraph has structure. */
export const PHASE_BY_KIND: Record<StepKind, Phase> = {
  read: "explore",
  search: "explore",
  web: "explore",
  plan: "plan",
  delegate: "plan",
  edit: "implement",
  shell: "implement",
  other: "implement",
  test: "verify",
};

export interface SpeedscopeFrame {
  name: string;
}

export type SpeedscopeEventType = "O" | "C";

export interface SpeedscopeEvent {
  type: SpeedscopeEventType;
  at: number;
  frame: number;
}

export interface SpeedscopeProfile {
  type: "evented";
  name: string;
  unit: "none";
  startValue: number;
  endValue: number;
  events: SpeedscopeEvent[];
}

export interface SpeedscopeFile {
  "$schema": string;
  shared: { frames: SpeedscopeFrame[] };
  profiles: SpeedscopeProfile[];
  name: string;
  exporter: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_FRAME_CHARS
    ? `${collapsed.slice(0, MAX_FRAME_CHARS - 1)}…`
    : collapsed;
}

function stringField(input: unknown, keys: string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function toolCommand(tool: ToolCall): string | undefined {
  return stringField(tool.input, ["command"]);
}

function toolFilePath(tool: ToolCall): string | undefined {
  return stringField(tool.input, [
    "file_path",
    "filePath",
    "filepath",
    "path",
    "notebook_path",
    "target_file",
    "file",
  ]);
}

function toolPattern(tool: ToolCall): string | undefined {
  return stringField(tool.input, ["pattern", "query", "regex", "search"]);
}

function programOf(segment: string): string {
  const first = segment.trim().split(/\s+/)[0] ?? "";
  return (first.replace(/^["']|["']$/g, "").split("/").pop() ?? first).toLowerCase();
}

function withoutCd(segments: string[]): string[] {
  return segments.filter((segment) => {
    const trimmed = segment.trim();
    if (trimmed === "") return false;
    return programOf(trimmed) !== "cd";
  });
}

function grepPattern(segment: string): string | undefined {
  const match = segment.match(
    /(?:^|\s)(?:grep|rg|ag)\s+(?:-[A-Za-z]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s]+))/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function bashFrameName(
  command: string,
  kind: StepKind,
  sessionCwd?: string,
): string {
  const segments = withoutCd(splitCommandSegments(command));
  const segment =
    segments.find((candidate) => {
      try {
        return classifyCommandSegment(candidate) === kind;
      } catch {
        return false;
      }
    }) ??
    segments[0] ??
    command;

  const words = segment.trim().split(/\s+/);
  const program = programOf(segment);
  const args = words.slice(1);

  if (kind === "read") {
    const candidate = args.filter((arg) => !arg.startsWith("-")).pop();
    return candidate === undefined
      ? truncate(segment)
      : truncate(`read ${displayPath(candidate, sessionCwd)}`);
  }

  if (kind === "search") {
    if (program === "grep" || program === "rg" || program === "ag") {
      const pattern = grepPattern(segment);
      return pattern === undefined
        ? truncate(segment)
        : truncate(`${program} "${pattern}"`);
    }
    return truncate(segment);
  }

  if (kind === "edit") {
    const redirect = segment.match(/>\s*([^\s;&|]+)/);
    const target = redirect?.[1];
    if (target !== undefined) return truncate(`edit ${displayPath(target, sessionCwd)}`);
    if (program === "tee") {
      const file = args.filter((arg) => !arg.startsWith("-")).pop();
      if (file !== undefined) {
        return truncate(`edit ${displayPath(file, sessionCwd)}`);
      }
    }
    return truncate(`edit ${segment}`);
  }

  return truncate(segment);
}

interface StepFrame {
  name: string;
  kind: StepKind;
}

/** Human-readable frame name for a step, e.g. "read src/a.ts", "npm test". */
export function stepFrameName(step: Step, sessionCwd?: string): StepFrame {
  const kind = step.kind ?? classifyStep(step);

  if (kind === "plan") return { name: "plan", kind };

  const tool =
    step.tools.find((candidate) => classifyToolCall(candidate) === kind) ??
    step.tools[0];

  if (tool === undefined) return { name: truncate(kind), kind };

  const command = toolCommand(tool);
  if (command !== undefined) {
    return { name: bashFrameName(command, kind, sessionCwd), kind };
  }

  if (kind === "read" || kind === "edit") {
    const path = toolFilePath(tool);
    return {
      name: truncate(`${kind} ${path === undefined ? tool.name : displayPath(path, sessionCwd)}`),
      kind,
    };
  }

  if (kind === "search") {
    const pattern = toolPattern(tool);
    if (pattern !== undefined) return { name: `grep "${pattern}"`, kind };
    const target = toolFilePath(tool);
    return {
      name: truncate(
        `${tool.name} ${target === undefined ? tool.name : displayPath(target, sessionCwd)}`,
      ),
      kind,
    };
  }

  if (kind === "web") {
    const target =
      toolPattern(tool) ??
      stringField(tool.input, ["url", "href"]) ??
      tool.name;
    return { name: truncate(`web ${target}`), kind };
  }

  if (kind === "delegate") {
    const target =
      stringField(tool.input, ["description", "prompt", "task"]) ?? tool.name;
    return { name: truncate(`delegate ${target}`), kind };
  }

  return { name: truncate(tool.name), kind };
}

/** Step width: cost in integer micro-dollars, or tokens when unpriced. */
export function stepSpanValue(step: Step): {
  value: number;
  usedTokens: boolean;
} {
  if (step.costUsd !== undefined && Number.isFinite(step.costUsd)) {
    return { value: Math.max(0, Math.round(step.costUsd * 1_000_000)), usedTokens: false };
  }

  const tokens = step.tokens;
  return {
    value:
      tokens.input +
      tokens.output +
      tokens.cacheRead +
      tokens.cacheWrite +
      tokens.reasoning,
    usedTokens: true,
  };
}

/**
 * Build an evented speedscope flamegraph whose width is cumulative cost.
 *
 * Frames nest session -> phase -> kind -> step. Unpriced steps fall back to
 * token counts for their width (and the profile is labelled "(tokens)"), which
 * keeps a partially-priced session renderable instead of dropping steps.
 */
export function buildSpeedscope(session: Session): SpeedscopeFile {
  const title = session.title ?? "(untitled)";
  const frames: SpeedscopeFrame[] = [];
  const frameIndex = new Map<string, number>();

  const frameId = (name: string): number => {
    const existing = frameIndex.get(name);
    if (existing !== undefined) return existing;
    const id = frames.length;
    frames.push({ name });
    frameIndex.set(name, id);
    return id;
  };

  const events: SpeedscopeEvent[] = [];
  let at = 0;
  let usedTokens = false;

  const open = (name: string): void => {
    events.push({ type: "O", at, frame: frameId(name) });
  };
  const close = (name: string): void => {
    events.push({ type: "C", at, frame: frameId(name) });
  };

  open(title);

  let currentPhase: Phase | undefined;
  let currentKind: StepKind | undefined;

  for (const step of session.steps) {
    const frame = stepFrameName(step, session.cwd);
    const kind = frame.kind;
    const phase = PHASE_BY_KIND[kind];

    if (phase !== currentPhase) {
      if (currentKind !== undefined) {
        close(currentKind);
        currentKind = undefined;
      }
      if (currentPhase !== undefined) close(currentPhase);
      open(phase);
      currentPhase = phase;
    }

    if (kind !== currentKind) {
      if (currentKind !== undefined) close(currentKind);
      open(kind);
      currentKind = kind;
    }

    open(frame.name);
    const priced = stepSpanValue(step);
    usedTokens = usedTokens || priced.usedTokens;
    at += priced.value;
    close(frame.name);
  }

  if (currentKind !== undefined) close(currentKind);
  if (currentPhase !== undefined) close(currentPhase);
  close(title);

  const profileName = usedTokens ? `${title} (tokens)` : title;

  return {
    "$schema": "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [
      {
        type: "evented",
        name: profileName,
        unit: "none",
        startValue: 0,
        endValue: at,
        events,
      },
    ],
    name: `downshift: ${title}`,
    exporter: `downshift@${packageJson.version}`,
  };
}

/** Structural check for balanced, non-decreasing evented speedscope profiles. */
export function validateSpeedscope(file: SpeedscopeFile): ValidationResult {
  const errors: string[] = [];
  const add = (message: string): void => {
    errors.push(message);
  };

  if (typeof file.name !== "string" || file.name === "") add("missing file name");
  if (typeof file.exporter !== "string" || file.exporter === "") {
    add("missing exporter");
  }
  if (!Array.isArray(file.shared?.frames)) add("missing shared.frames");

  const frames = file.shared?.frames ?? [];
  frames.forEach((frame, index) => {
    if (typeof frame.name !== "string" || frame.name === "") {
      add(`frame ${index} has no name`);
    }
  });

  if (!Array.isArray(file.profiles) || file.profiles.length === 0) {
    add("missing profiles");
    return { valid: false, errors };
  }

  file.profiles.forEach((profile, profileIndex) => {
    const label = `profile ${profileIndex}`;
    if (profile.type !== "evented") add(`${label}: expected evented profile`);
    if (profile.unit !== "none") add(`${label}: expected unit "none"`);
    if (profile.startValue !== 0) add(`${label}: startValue must be 0`);
    if (!Number.isInteger(profile.endValue) || profile.endValue < 0) {
      add(`${label}: endValue must be a non-negative integer`);
    }

    const stack: number[] = [];
    let previousAt = 0;

    profile.events.forEach((event, eventIndex) => {
      const eventLabel = `${label} event ${eventIndex}`;
      if (event.type !== "O" && event.type !== "C") {
        add(`${eventLabel}: type must be O or C`);
        return;
      }
      if (!Number.isInteger(event.at) || event.at < 0) {
        add(`${eventLabel}: at must be a non-negative integer`);
        return;
      }
      if (event.at < previousAt) {
        add(`${eventLabel}: at decreased from ${previousAt} to ${event.at}`);
      }
      previousAt = event.at;

      if (!Number.isInteger(event.frame) || event.frame < 0 || event.frame >= frames.length) {
        add(`${eventLabel}: frame ${event.frame} is out of range`);
        return;
      }

      if (event.type === "O") {
        stack.push(event.frame);
        return;
      }

      const opened = stack.pop();
      if (opened === undefined) {
        add(`${eventLabel}: close without matching open`);
      } else if (opened !== event.frame) {
        add(`${eventLabel}: close frame ${event.frame} does not match open ${opened}`);
      }
    });

    if (stack.length > 0) add(`${label}: ${stack.length} frame(s) never closed`);
    if (profile.events.length > 0 && profile.endValue !== previousAt) {
      add(
        `${label}: endValue ${profile.endValue} does not match last event at ${previousAt}`,
      );
    }
  });

  return { valid: errors.length === 0, errors };
}