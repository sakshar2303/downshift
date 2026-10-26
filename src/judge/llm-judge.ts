import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  chat,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "../providers/index.js";

/** Groq's free tier serves the large model; Ollama is the local fallback. */
export const PLAN_JUDGE_PRIMARY = "groq:openai/gpt-oss-120b";
export const PLAN_JUDGE_FALLBACK = "ollama:gemma4:latest";

const JUDGE_CACHE_DIR = join(".downshift", "judge");
const MAX_OUTPUT_TOKENS = 200;

const judgeSchema = z.object({
  same: z.boolean(),
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type PlanJudgement = z.infer<typeof judgeSchema>;

export interface PlanJudgeResult extends PlanJudgement {
  modelRef: string;
  cached: boolean;
}

export interface PlanJudgeOptions {
  /** Primary model first, then fallbacks. */
  models?: string[];
  cacheDir?: string;
  /** Injectable chat client, primarily for tests. */
  chatFn?: (modelRef: string, options: ChatOptions) => Promise<ChatResult>;
  /** Disable the on-disk cache (tests that assert call counts). */
  cache?: boolean;
}

interface CachedJudgement extends PlanJudgement {
  modelRef: string;
}

const SYSTEM_PROMPT =
  "You judge coding-agent plans. Compare the ORIGINAL next step with the REPLAYED next step. Decide whether they commit to the same concrete action: the same tool, file, command, or goal. Wording may differ; only the intended action matters. Reply with ONLY a JSON object, no markdown, shaped exactly like " +
  '{"same": true, "score": 0.9, "reason": "both edit src/csv.ts"}.' +
  " score is 0..1, where 1 means the same action.";

function promptFor(original: string, replayed: string): string {
  return `ORIGINAL NEXT STEP:\n${original}\n\nREPLAYED NEXT STEP:\n${replayed}`;
}

function messagesFor(original: string, replayed: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: promptFor(original, replayed) },
  ];
}

/**
 * Pull a JSON object out of a model reply. Free models often wrap JSON in
 * prose or a markdown fence even when told not to, so try the raw string and
 * then the outermost {...} span.
 */
export function parseJudgement(content: string): PlanJudgement | undefined {
  const candidates: string[] = [content.trim()];
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(content.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    if (candidate === "") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      const result = judgeSchema.safeParse(parsed);
      if (result.success) return result.data;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function cachePathFor(
  cacheDir: string,
  models: string[],
  original: string,
  replayed: string,
): string {
  const hash = createHash("sha256")
    .update(`${models.join(",")}\n${original}\n---\n${replayed}`)
    .digest("hex");
  return join(cacheDir, `${hash}.json`);
}

function readCache(path: string): CachedJudgement | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = z
      .object({
        same: z.boolean(),
        score: z.number().min(0).max(1),
        reason: z.string().min(1),
        modelRef: z.string(),
      })
      .safeParse(parsed);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

function writeCache(path: string, value: CachedJudgement): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
  } catch {
    // A read-only cache directory must not break judging.
  }
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

/**
 * Decide whether two plan steps commit to the same action.
 *
 * The primary model gets one retry if its reply is not valid JSON, then each
 * fallback gets the same treatment. Successful judgements are cached on disk,
 * keyed by the prompt and model list, so reruns and policy generation are free.
 */
export async function judgePlan(
  original: string,
  replayed: string,
  options: PlanJudgeOptions = {},
): Promise<PlanJudgeResult> {
  if (original.trim() === replayed.trim() && original.trim() !== "") {
    return {
      same: true,
      score: 1,
      reason: "identical plan text",
      modelRef: "deterministic",
      cached: false,
    };
  }

  const models =
    options.models !== undefined && options.models.length > 0
      ? options.models
      : [PLAN_JUDGE_PRIMARY, PLAN_JUDGE_FALLBACK];
  const cachePath = cachePathFor(
    options.cacheDir ?? JUDGE_CACHE_DIR,
    models,
    original,
    replayed,
  );
  const useCache = options.cache !== false;

  if (useCache) {
    const cached = readCache(cachePath);
    if (cached !== undefined) {
      const { modelRef, ...judgement } = cached;
      return { ...judgement, modelRef, cached: true };
    }
  }

  const chatFn = options.chatFn ?? chat;
  const messages = messagesFor(original, replayed);
  const failures: string[] = [];

  for (const modelRef of models) {
    // Two attempts: the first reply may be prose or a broken fence.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result: ChatResult;
      try {
        result = await chatFn(modelRef, {
          messages,
          temperature: 0,
          maxTokens: MAX_OUTPUT_TOKENS,
        });
      } catch (error) {
        failures.push(
          `${modelRef}: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
        );
        // A provider failure is not a JSON problem; move to the fallback.
        break;
      }

      const content = result.message.content ?? "";
      const judgement = parseJudgement(content);
      if (judgement !== undefined) {
        if (useCache) writeCache(cachePath, { ...judgement, modelRef });
        return { ...judgement, modelRef, cached: false };
      }
      failures.push(`${modelRef}: invalid JSON`);
    }
  }

  throw new Error(
    `Plan judge failed for every model (${failures.join("; ")}).`,
  );
}