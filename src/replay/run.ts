import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  chat,
  parseModelRef,
  providers,
  type ChatResult,
  type ProviderId,
} from "../providers/index.js";
import type { Session, StepKind } from "../types.js";
import {
  buildReplayRequest,
  type ReplayAction,
  type ReplayRequest,
} from "./context.js";
import { score, type JudgedAction } from "../judge/action-match.js";
import {
  judgePlan,
  type PlanJudgeResult,
} from "../judge/llm-judge.js";
import { sampleSteps } from "./sampler.js";
import type { CanonicalAction, CanonicalToolName } from "./tools.js";

const REPLAY_DIR = join(".downshift", "replay");
const REPORT_PATH = join("downshift-report", "replays.json");

/**
 * Rough per-call wall-clock estimates. Groq's token bucket is the dominant
 * cost: a ~5.8k-token request refills for about 50s before the next call.
 */
const SECONDS_PER_CALL: Record<ProviderId, number> = {
  ollama: 2,
  groq: 55,
  openrouter: 6,
};

export type ReplayedAction =
  | { tool: string; args: unknown }
  | { text: string };

export interface ReplayRecord {
  stepIndex: number;
  kind: StepKind;
  modelRef: string;
  replayed: ReplayedAction | null;
  usage: ChatResult["usage"] | null;
  latencyMs: number;
  error?: string;
  cached?: boolean;
  /** Deterministic action-match score, or the LLM judge score for plans. */
  score?: number;
  judge?: PlanJudgeResult | null;
  judgeError?: string;
}

export interface ReplayReport {
  version: 1;
  generatedAt: string;
  session: {
    id: string;
    title: string | null;
    source: Session["source"];
    path: string;
    model: string;
  };
  options: {
    perKind: number;
    seed: number;
    models: string[];
  };
  records: ReplayRecord[];
}

export interface ReplayModelPlan {
  modelRef: string;
  provider: ProviderId;
  calls: number;
  cached: number;
  estimatedMs: number;
}

export interface ReplayPlan {
  totalCalls: number;
  cachedCalls: number;
  models: ReplayModelPlan[];
  estimatedMs: number;
}

export interface ReplayHooks {
  onPlan?: (plan: ReplayPlan) => void;
  onProgress?: (record: ReplayRecord, completed: number, total: number) => void;
}

export interface ReplayOptions {
  models: string[];
  perKind: number;
  seed: number;
  /** Injectable plan judge, primarily for tests. */
  judgePlanStep?: (original: string, replayed: string) => Promise<PlanJudgeResult>;
}

interface CachedChat {
  message: ChatResult["message"];
  usage: ChatResult["usage"] | null;
  latencyMs: number;
}

interface PreparedCall {
  stepIndex: number;
  kind: StepKind;
  modelRef: string;
  provider: ProviderId;
  request: ReplayRequest;
  cachePath: string;
  cached: boolean;
}

function cachePathFor(modelRef: string, request: ReplayRequest): string {
  const hash = createHash("sha256")
    .update(`${modelRef}${JSON.stringify(request)}`)
    .digest("hex");
  return join(REPLAY_DIR, `${hash}.json`);
}

function readCache(path: string): CachedChat | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.message !== "object" || record.message === null) {
      return undefined;
    }
    return {
      message: record.message as ChatResult["message"],
      usage: (record.usage as ChatResult["usage"] | null) ?? null,
      latencyMs:
        typeof record.latencyMs === "number" && Number.isFinite(record.latencyMs)
          ? record.latencyMs
          : 0,
    };
  } catch {
    return undefined;
  }
}

function writeCache(path: string, value: CachedChat): void {
  mkdirSync(REPLAY_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

/** Convert a replay response into the shape the action scorer understands. */
function judgedAction(replayed: ReplayedAction | null): JudgedAction {
  if (replayed === null) return null;
  if ("text" in replayed) return { text: replayed.text };
  return {
    tool: replayed.tool as CanonicalToolName,
    args:
      typeof replayed.args === "object" && replayed.args !== null
        ? (replayed.args as Record<string, unknown>)
        : {},
  };
}

function replayedText(replayed: ReplayedAction | null): string {
  if (replayed === null) return "";
  if ("text" in replayed) return replayed.text;
  return JSON.stringify({ tool: replayed.tool, args: replayed.args });
}

/**
 * Score how closely a replay reproduced the recorded step. Tool steps use the
 * deterministic scorer; plan steps (text) go to the LLM judge.
 */
async function attachScore(
  record: ReplayRecord,
  original: ReplayAction | null,
  cwd: string,
  judge: (original: string, replayed: string) => Promise<PlanJudgeResult>,
): Promise<void> {
  if (original === null) return;

  if (!("text" in original)) {
    const canonicalOriginal: CanonicalAction = original;
    record.score = score(judgedAction(record.replayed), canonicalOriginal, cwd);
    return;
  }

  if (record.replayed === null) {
    record.score = 0;
    return;
  }

  try {
    const judgement = await judge(original.text, replayedText(record.replayed));
    record.judge = judgement;
    record.score = judgement.score;
  } catch (error) {
    record.judgeError = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function replayedAction(message: ChatResult["message"]): ReplayedAction | null {
  const call = message.tool_calls?.[0];
  if (call !== undefined) {
    let args: unknown = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      args = {};
    }
    return { tool: call.function.name, args };
  }

  if (typeof message.content === "string" && message.content.trim() !== "") {
    return { text: message.content };
  }
  return null;
}

function redactSecrets(message: string): string {
  let redacted = message;
  for (const key of [process.env.GROQ_API_KEY, process.env.OPENROUTER_API_KEY]) {
    if (key !== undefined && key.length >= 6) {
      redacted = redacted.split(key).join("[redacted]");
    }
  }
  return redacted;
}

function frontierModel(session: Session): string {
  const counts = new Map<string, number>();
  for (const step of session.steps) {
    if (step.model === "") continue;
    counts.set(step.model, (counts.get(step.model) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

function prepareCalls(session: Session, options: ReplayOptions): PreparedCall[] {
  const models = [...new Set(options.models)];
  const sampled = sampleSteps(session, options.perKind, options.seed);
  const calls: PreparedCall[] = [];

  for (const sample of sampled) {
    for (const modelRef of models) {
      const parsed = parseModelRef(modelRef);
      const provider = providers[parsed.provider];
      const request = buildReplayRequest(
        session,
        sample.stepIndex,
        provider.maxContextTokens,
      );
      const cachePath = cachePathFor(modelRef, request);
      calls.push({
        stepIndex: sample.stepIndex,
        kind: sample.kind,
        modelRef,
        provider: parsed.provider,
        request,
        cachePath,
        cached: readCache(cachePath) !== undefined,
      });
    }
  }

  return calls;
}

function buildPlan(calls: PreparedCall[]): ReplayPlan {
  const byModel = new Map<string, ReplayModelPlan>();

  for (const call of calls) {
    const existing = byModel.get(call.modelRef) ?? {
      modelRef: call.modelRef,
      provider: call.provider,
      calls: 0,
      cached: 0,
      estimatedMs: 0,
    };
    existing.calls += 1;
    if (call.cached) existing.cached += 1;
    else existing.estimatedMs += SECONDS_PER_CALL[call.provider] * 1_000;
    byModel.set(call.modelRef, existing);
  }

  const models = [...byModel.values()];
  return {
    totalCalls: calls.length,
    cachedCalls: calls.filter((call) => call.cached).length,
    models,
    estimatedMs: models.reduce((sum, model) => sum + model.estimatedMs, 0),
  };
}

/**
 * Replay sampled steps against each model.
 *
 * Responses are cached by (modelRef, request) before anything else, so a rerun
 * is free, instant, and does not touch a free-tier rate limit again. A failed
 * call is recorded with its error and intentionally not cached, so a later run
 * can retry it.
 */
export async function runReplay(
  session: Session,
  options: ReplayOptions,
  hooks: ReplayHooks = {},
): Promise<ReplayReport> {
  const calls = prepareCalls(session, options);
  hooks.onPlan?.(buildPlan(calls));

  const records: ReplayRecord[] = [];
  const cwd = session.cwd ?? process.cwd();
  const judge = options.judgePlanStep ?? judgePlan;

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index] as PreparedCall;
    const cached = readCache(call.cachePath);

    if (cached !== undefined) {
      const record: ReplayRecord = {
        stepIndex: call.stepIndex,
        kind: call.kind,
        modelRef: call.modelRef,
        replayed: replayedAction(cached.message),
        usage: cached.usage,
        latencyMs: cached.latencyMs,
        cached: true,
      };
      await attachScore(record, call.request.original, cwd, judge);
      records.push(record);
      hooks.onProgress?.(record, index + 1, calls.length);
      continue;
    }

    try {
      const result = await chat(call.modelRef, {
        messages: call.request.messages,
        tools: call.request.tools,
        toolChoice: "auto",
        temperature: 0,
        maxTokens: 512,
      });
      writeCache(call.cachePath, {
        message: result.message,
        usage: result.usage ?? null,
        latencyMs: result.latencyMs,
      });
      const record: ReplayRecord = {
        stepIndex: call.stepIndex,
        kind: call.kind,
        modelRef: call.modelRef,
        replayed: replayedAction(result.message),
        usage: result.usage ?? null,
        latencyMs: result.latencyMs,
        cached: false,
      };
      await attachScore(record, call.request.original, cwd, judge);
      records.push(record);
      hooks.onProgress?.(record, index + 1, calls.length);
    } catch (error) {
      const record: ReplayRecord = {
        stepIndex: call.stepIndex,
        kind: call.kind,
        modelRef: call.modelRef,
        replayed: null,
        usage: null,
        latencyMs: 0,
        error: redactSecrets(
          error instanceof Error ? error.message : String(error),
        ),
        cached: false,
      };
      records.push(record);
      hooks.onProgress?.(record, index + 1, calls.length);
    }
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    session: {
      id: session.id,
      title: session.title ?? null,
      source: session.source,
      path: session.path,
      model: frontierModel(session),
    },
    options: {
      perKind: options.perKind,
      seed: options.seed,
      models: [...new Set(options.models)],
    },
    records,
  };
}

/** Write downshift-report/replays.json and return the path. */
export function writeReplayReport(
  report: ReplayReport,
  path = REPORT_PATH,
): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  return path;
}