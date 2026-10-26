import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Session, Step, Tokens, ToolCall } from "../types.js";

/** Tool results are clipped so a single huge output can't dominate a session. */
const MAX_TOOL_OUTPUT_CHARS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toMillis(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept both seconds and milliseconds.
    return Math.round(value < 1_000_000_000_000 ? value * 1000 : value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMillis(numeric);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readTokens(usage: unknown): Tokens {
  if (!isRecord(usage)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  }
  const count = (key: string): number => {
    const value = usage[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  return {
    input: count("input_tokens"),
    output: count("output_tokens"),
    cacheRead: count("cache_read_input_tokens"),
    cacheWrite: count("cache_creation_input_tokens"),
    reasoning: 0,
  };
}

function stringifyToolOutput(content: unknown): string {
  const raw =
    typeof content === "string"
      ? content
      : (JSON.stringify(content) ?? String(content));
  return raw.length > MAX_TOOL_OUTPUT_CHARS
    ? raw.slice(0, MAX_TOOL_OUTPUT_CHARS)
    : raw;
}

function deriveSessionId(path: string): string {
  return basename(path).replace(/\.jsonl$/i, "") || "unknown";
}

/**
 * Parse a Claude Code transcript (JSONL) into a normalized session.
 *
 * Claude Code writes one API response across several JSONL lines that share the
 * same `message.id`, so assistant lines are merged by message id and usage is
 * counted once per id rather than once per line.
 */
export function parseClaudeCodeTranscript(path: string): Session {
  const raw = readFileSync(path, "utf8");
  const steps: Step[] = [];
  const stepsByMessageId = new Map<string, Step>();
  const usedUsageFor = new Set<string>();
  const toolOutputs = new Map<string, string>();

  let sessionId: string | undefined;
  let cwd: string | undefined;
  let anonymousSteps = 0;

  const attachOutput = (toolUseId: string, output: string): void => {
    toolOutputs.set(toolUseId, output);
    for (const step of steps) {
      const tool = step.tools.find((candidate) => candidate.id === toolUseId);
      if (tool) {
        tool.output = output;
        return;
      }
    }
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const type = parsed.type;
    if (type !== "assistant" && type !== "user") continue;

    const lineSessionId = asString(parsed.sessionId);
    if (lineSessionId !== undefined && sessionId === undefined) {
      sessionId = lineSessionId;
    }
    const lineCwd = asString(parsed.cwd);
    if (lineCwd !== undefined && cwd === undefined) {
      cwd = lineCwd;
    }

    const message = isRecord(parsed.message) ? parsed.message : undefined;
    if (message === undefined) continue;

    const content = message.content;

    if (type === "user") {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const toolUseId = asString(block.tool_use_id);
        if (toolUseId === undefined) continue;
        attachOutput(toolUseId, stringifyToolOutput(block.content));
      }
      continue;
    }

    const messageId = asString(message.id);
    const key = messageId ?? `anonymous-${anonymousSteps++}`;
    const stepSessionId = lineSessionId ?? sessionId ?? deriveSessionId(path);

    let step = stepsByMessageId.get(key);
    if (step === undefined) {
      step = {
        id: key,
        index: steps.length,
        sessionId: stepSessionId,
        source: "claude-code",
        model: asString(message.model) ?? "",
        startedAt: toMillis(parsed.timestamp),
        tools: [],
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        isSidechain: parsed.isSidechain === true,
      };
      stepsByMessageId.set(key, step);
      steps.push(step);
    } else {
      const model = asString(message.model);
      if (step.model === "" && model !== undefined) step.model = model;
    }

    if (!usedUsageFor.has(key) && isRecord(message.usage)) {
      step.tokens = readTokens(message.usage);
      usedUsageFor.add(key);
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isRecord(block)) continue;

      if (block.type === "text") {
        const text = asString(block.text);
        if (text === undefined) continue;
        step.text = step.text === undefined ? text : `${step.text}\n${text}`;
        continue;
      }

      if (block.type === "tool_use") {
        const id = asString(block.id);
        const name = asString(block.name);
        if (id === undefined || name === undefined) continue;
        if (step.tools.some((tool) => tool.id === id)) continue;

        const call: ToolCall = { id, name, input: block.input ?? {} };
        const pendingOutput = toolOutputs.get(id);
        if (pendingOutput !== undefined) call.output = pendingOutput;
        step.tools.push(call);
      }
      // "thinking" and any unknown block types are intentionally ignored.
    }
  }

  const resolvedSessionId = sessionId ?? deriveSessionId(path);
  return {
    id: resolvedSessionId,
    source: "claude-code",
    path,
    cwd,
    steps,
  };
}