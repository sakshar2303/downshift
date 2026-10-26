import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAN_JUDGE_FALLBACK,
  PLAN_JUDGE_PRIMARY,
  judgePlan,
  parseJudgement,
} from "../src/judge/llm-judge.js";
import type { ChatOptions, ChatResult } from "../src/providers/index.js";

function reply(content: string): ChatResult {
  return {
    message: { role: "assistant", content } as ChatResult["message"],
    usage: undefined,
    latencyMs: 1,
  };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "downshift-judge-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseJudgement", () => {
  it("parses exact JSON", () => {
    expect(
      parseJudgement('{"same":true,"score":0.9,"reason":"both edit csv.ts"}'),
    ).toEqual({ same: true, score: 0.9, reason: "both edit csv.ts" });
  });

  it("parses JSON inside a markdown fence", () => {
    expect(
      parseJudgement('```json\n{"same":false,"score":0.1,"reason":"different"}\n```'),
    ).toEqual({ same: false, score: 0.1, reason: "different" });
  });

  it("parses the outermost object in prose", () => {
    expect(
      parseJudgement('Sure. {"same":true,"score":1,"reason":"identical"} Done.'),
    ).toEqual({ same: true, score: 1, reason: "identical" });
  });

  it("rejects missing fields, wrong types, and out-of-range scores", () => {
    expect(parseJudgement('{"same":true,"score":0.5}')).toBeUndefined();
    expect(
      parseJudgement('{"same":"yes","score":0.5,"reason":"x"}'),
    ).toBeUndefined();
    expect(
      parseJudgement('{"same":true,"score":1.5,"reason":"x"}'),
    ).toBeUndefined();
    expect(
      parseJudgement('{"same":true,"score":-0.1,"reason":"x"}'),
    ).toBeUndefined();
    expect(
      parseJudgement('{"same":true,"score":0.5,"reason":""}'),
    ).toBeUndefined();
  });

  it("rejects malformed and non-object JSON", () => {
    expect(parseJudgement("not json")).toBeUndefined();
    expect(parseJudgement("[1,2,3]")).toBeUndefined();
    expect(parseJudgement("")).toBeUndefined();
  });
});

describe("judgePlan", () => {
  it("short-circuits identical non-empty plans without a model call", async () => {
    let calls = 0;
    const result = await judgePlan("edit src/csv.ts", "edit src/csv.ts", {
      cacheDir: tempDir(),
      chatFn: async () => {
        calls += 1;
        return reply('{"same":true,"score":1,"reason":"x"}');
      },
    });
    expect(result).toMatchObject({
      same: true,
      score: 1,
      modelRef: "deterministic",
    });
    expect(calls).toBe(0);
  });

  it("does not short-circuit empty plans", async () => {
    const result = await judgePlan("", "", {
      cacheDir: tempDir(),
      chatFn: async () => reply('{"same":true,"score":1,"reason":"empty"}'),
    });
    expect(result.modelRef).toBe(PLAN_JUDGE_PRIMARY);
  });

  it("returns a valid primary judgement and caches it", async () => {
    const cacheDir = tempDir();
    let calls = 0;
    const chatFn = async (modelRef: string): Promise<ChatResult> => {
      calls += 1;
      expect(modelRef).toBe(PLAN_JUDGE_PRIMARY);
      return reply('{"same":true,"score":0.95,"reason":"same file"}');
    };

    const first = await judgePlan("edit a.ts", "write a.ts", { cacheDir, chatFn });
    expect(first).toEqual({
      same: true,
      score: 0.95,
      reason: "same file",
      modelRef: PLAN_JUDGE_PRIMARY,
      cached: false,
    });
    expect(calls).toBe(1);

    const second = await judgePlan("edit a.ts", "write a.ts", { cacheDir, chatFn });
    expect(second.cached).toBe(true);
    expect(second.modelRef).toBe(PLAN_JUDGE_PRIMARY);
    expect(calls).toBe(1);
  });

  it("retries once on invalid JSON before accepting", async () => {
    const calls: string[] = [];
    const result = await judgePlan("a", "b", {
      cacheDir: tempDir(),
      chatFn: async (modelRef) => {
        calls.push(modelRef);
        return calls.length === 1
          ? reply("I think they are the same.")
          : reply('{"same":false,"score":0.2,"reason":"different"}');
      },
    });

    expect(calls).toEqual([PLAN_JUDGE_PRIMARY, PLAN_JUDGE_PRIMARY]);
    expect(result.score).toBe(0.2);
    expect(result.cached).toBe(false);
  });

  it("falls back when the primary fails twice", async () => {
    const calls: string[] = [];
    const result = await judgePlan("a", "b", {
      cacheDir: tempDir(),
      chatFn: async (modelRef) => {
        calls.push(modelRef);
        return modelRef === PLAN_JUDGE_PRIMARY
          ? reply("still not json")
          : reply('{"same":true,"score":0.8,"reason":"fallback"}');
      },
    });

    expect(calls).toEqual([
      PLAN_JUDGE_PRIMARY,
      PLAN_JUDGE_PRIMARY,
      PLAN_JUDGE_FALLBACK,
    ]);
    expect(result.modelRef).toBe(PLAN_JUDGE_FALLBACK);
  });

  it("falls back when the primary throws", async () => {
    const calls: string[] = [];
    const result = await judgePlan("a", "b", {
      cacheDir: tempDir(),
      chatFn: async (modelRef) => {
        calls.push(modelRef);
        if (modelRef === PLAN_JUDGE_PRIMARY) throw new Error("429 rate limited");
        return reply('{"same":false,"score":0.4,"reason":"small model"}');
      },
    });

    expect(calls).toEqual([PLAN_JUDGE_PRIMARY, PLAN_JUDGE_FALLBACK]);
    expect(result.modelRef).toBe(PLAN_JUDGE_FALLBACK);
  });

  it("throws when every model fails validation", async () => {
    await expect(
      judgePlan("a", "b", {
        cacheDir: tempDir(),
        chatFn: async () => reply("nope"),
      }),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("uses a custom model list and cache key", async () => {
    const calls: string[] = [];
    const result = await judgePlan("a", "b", {
      cacheDir: tempDir(),
      models: ["ollama:tester"],
      chatFn: async (modelRef) => {
        calls.push(modelRef);
        return reply('{"same":true,"score":0.7,"reason":"ok"}');
      },
    });
    expect(calls).toEqual(["ollama:tester"]);
    expect(result.modelRef).toBe("ollama:tester");
  });

  it("can disable the cache", async () => {
    const cacheDir = tempDir();
    let calls = 0;
    const chatFn = async (): Promise<ChatResult> => {
      calls += 1;
      return reply('{"same":true,"score":0.9,"reason":"x"}');
    };

    await judgePlan("a", "b", { cacheDir, cache: false, chatFn });
    await judgePlan("a", "b", { cacheDir, cache: false, chatFn });
    expect(calls).toBe(2);
  });

  it("passes deterministic chat options", async () => {
    let seen: ChatOptions | undefined;
    await judgePlan("a", "b", {
      cacheDir: tempDir(),
      chatFn: async (_modelRef, options) => {
        seen = options;
        return reply('{"same":true,"score":0.9,"reason":"x"}');
      },
    });
    expect(seen?.temperature).toBe(0);
    expect(seen?.maxTokens).toBe(200);
    expect(seen?.tools).toBeUndefined();
  });
});