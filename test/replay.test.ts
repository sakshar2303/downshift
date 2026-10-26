import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseClaudeCodeTranscript } from "../src/ingest/claude-code.js";
import {
  buildReplayRequest,
  type ReplayRequest,
} from "../src/replay/context.js";
import { sampleSteps } from "../src/replay/sampler.js";
import {
  canonicalTools,
  stepCanonicalAction,
  toCanonicalAction,
} from "../src/replay/tools.js";
import type { Session, Step, ToolCall } from "../src/types.js";

function tool(name: string, input: unknown, output?: string): ToolCall {
  return { id: `tool-${name}`, name, input, output };
}

function step(index: number, overrides: Partial<Step> = {}): Step {
  return {
    id: `step-${index}`,
    index,
    sessionId: "session-replay",
    source: "claude-code",
    model: "claude-sonnet-4-5",
    startedAt: index * 1000,
    tools: [],
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    isSidechain: false,
    ...overrides,
  };
}

function session(steps: Step[], firstUserMessage = "Fix the bug."): Session {
  return {
    id: "session-replay",
    source: "claude-code",
    title: "Replay",
    firstUserMessage,
    path: "/tmp/replay.jsonl",
    cwd: "/tmp/project",
    steps,
  };
}

function estimate(request: ReplayRequest): number {
  return Math.ceil(JSON.stringify(request.messages).length / 4);
}

function messageText(request: ReplayRequest): string {
  return JSON.stringify(request.messages);
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("canonical tool mapping", () => {
  it("exports the canonical tool set", () => {
    expect(canonicalTools.map((entry) => entry.function.name)).toEqual([
      "read_file",
      "search",
      "list_files",
      "edit_file",
      "write_file",
      "run_command",
      "finish",
    ]);
  });

  it("maps reads and their aliases", () => {
    expect(toCanonicalAction(tool("Read", { file_path: "src/a.ts" }))).toEqual({
      tool: "read_file",
      args: { path: "src/a.ts" },
    });
    expect(toCanonicalAction(tool("read", { path: "src/b.ts" }))).toEqual({
      tool: "read_file",
      args: { path: "src/b.ts" },
    });
    expect(toCanonicalAction(tool("view", { file_path: "img.png" }))).toEqual({
      tool: "read_file",
      args: { path: "img.png" },
    });
  });

  it("maps searches and their aliases", () => {
    expect(
      toCanonicalAction(tool("Grep", { pattern: "foo", path: "src" })),
    ).toEqual({ tool: "search", args: { pattern: "foo", path: "src" } });
    expect(toCanonicalAction(tool("grep", { pattern: "bar" }))).toEqual({
      tool: "search",
      args: { pattern: "bar" },
    });
    expect(toCanonicalAction(tool("Glob", { pattern: "*.ts" }))).toEqual({
      tool: "search",
      args: { pattern: "*.ts" },
    });
    expect(toCanonicalAction(tool("glob", { pattern: "src/**" }))).toEqual({
      tool: "search",
      args: { pattern: "src/**" },
    });
    expect(toCanonicalAction(tool("find", { query: "TODO" }))).toEqual({
      tool: "search",
      args: { pattern: "TODO" },
    });
  });

  it("maps directory listings", () => {
    expect(toCanonicalAction(tool("LS", {}))).toEqual({
      tool: "list_files",
      args: { path: "." },
    });
    expect(toCanonicalAction(tool("list", { path: "src" }))).toEqual({
      tool: "list_files",
      args: { path: "src" },
    });
  });

  it("maps edits, including MultiEdit's first hunk", () => {
    expect(
      toCanonicalAction(
        tool("Edit", {
          file_path: "src/a.ts",
          old_string: "a",
          new_string: "b",
        }),
      ),
    ).toEqual({
      tool: "edit_file",
      args: { path: "src/a.ts", old_string: "a", new_string: "b" },
    });
    expect(
      toCanonicalAction(
        tool("MultiEdit", {
          file_path: "src/a.ts",
          edits: [
            { old_string: "one", new_string: "two" },
            { old_string: "three", new_string: "four" },
          ],
        }),
      ),
    ).toEqual({
      tool: "edit_file",
      args: { path: "src/a.ts", old_string: "one", new_string: "two" },
    });
    expect(
      toCanonicalAction(
        tool("patch", { path: "src/a.ts", old_string: "x", new_string: "y" }),
      ),
    ).toEqual({
      tool: "edit_file",
      args: { path: "src/a.ts", old_string: "x", new_string: "y" },
    });
  });

  it("maps writes", () => {
    expect(
      toCanonicalAction(tool("Write", { file_path: "src/a.ts", content: "hi" })),
    ).toEqual({
      tool: "write_file",
      args: { path: "src/a.ts", content: "hi" },
    });
    expect(toCanonicalAction(tool("write", { path: "b.ts", content: "" }))).toEqual({
      tool: "write_file",
      args: { path: "b.ts", content: "" },
    });
  });

  it("maps shell commands", () => {
    expect(
      toCanonicalAction(tool("Bash", { command: "npm test" })),
    ).toEqual({ tool: "run_command", args: { command: "npm test" } });
    expect(
      toCanonicalAction(tool("execute", { command: "git status" })),
    ).toEqual({ tool: "run_command", args: { command: "git status" } });
  });

  it("returns null for unknown tools and unusable arguments", () => {
    expect(toCanonicalAction(tool("Task", { prompt: "do it" }))).toBeNull();
    expect(toCanonicalAction(tool("mcp__github__issue", {}))).toBeNull();
    expect(toCanonicalAction(tool("Read", {}))).toBeNull();
    expect(toCanonicalAction(tool("Write", { path: "a.ts" }))).toBeNull();
    expect(toCanonicalAction(tool("Bash", {}))).toBeNull();
  });

  it("picks the first mappable action from a step", () => {
    expect(
      stepCanonicalAction([
        tool("TodoWrite", { todos: [] }),
        tool("Read", { file_path: "src/a.ts" }),
      ]),
    ).toEqual({ tool: "read_file", args: { path: "src/a.ts" } });
    expect(stepCanonicalAction([tool("TodoWrite", { todos: [] })])).toBeNull();
  });
});

describe("buildReplayRequest", () => {
  const readTarget = step(3, {
    tools: [tool("Read", { file_path: "src/target.ts" })],
  });
  const replaySession = session(
    [
      step(0, {
        tools: [tool("Read", { file_path: "src/a.ts" }, "A".repeat(5_000))],
        text: "I should read the file.",
      }),
      step(1, {
        tools: [tool("Bash", { command: "npm test" }, "all green")],
      }),
      step(2, { text: "Now make the change." }),
      readTarget,
    ],
    "Please fix the failing test.",
  );

  const request = buildReplayRequest(replaySession, 3, 100_000);

  it("starts with the system prompt and first user message", () => {
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[1]).toEqual({
      role: "user",
      content: "Please fix the failing test.",
    });
  });

  it("reconstructs prior assistant turns with canonical tool calls", () => {
    const firstAssistant = request.messages[2];
    expect(firstAssistant?.role).toBe("assistant");
    if (firstAssistant?.role !== "assistant") return;
    expect(firstAssistant.content).toBe("I should read the file.");
    expect(firstAssistant.tool_calls?.[0]?.type).toBe("function");
    expect(firstAssistant.tool_calls?.[0]?.function.name).toBe("read_file");
    expect(
      JSON.parse(firstAssistant.tool_calls?.[0]?.function.arguments ?? "{}"),
    ).toEqual({ path: "src/a.ts" });

    const bashAssistant = request.messages[4];
    expect(bashAssistant?.role).toBe("assistant");
    if (bashAssistant?.role !== "assistant") return;
    expect(bashAssistant.tool_calls?.[0]?.function.name).toBe("run_command");
  });

  it("truncates tool outputs to 1500 chars", () => {
    const toolMessage = request.messages[3];
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") return;
    expect(toolMessage.content).toHaveLength(1_500);
  });

  it("does not include the target step or later steps", () => {
    expect(messageText(request)).not.toContain("src/target.ts");
  });

  it("returns the target's canonical action as the original", () => {
    expect(request.original).toEqual({
      tool: "read_file",
      args: { path: "src/target.ts" },
    });
  });

  it("returns text for plan steps", () => {
    const plan = buildReplayRequest(
      session([step(0, { kind: "plan", text: "I will edit src/a.ts." })]),
      0,
      10_000,
    );
    expect(plan.original).toEqual({ text: "I will edit src/a.ts." });
  });

  it("returns null for unreplayable steps", () => {
    const unreplayable = buildReplayRequest(
      session([step(0, { tools: [tool("Task", { prompt: "x" })] })]),
      0,
      10_000,
    );
    expect(unreplayable.original).toBeNull();
  });

  it("excludes sidechain steps from history", () => {
    const withSidechain = session([
      step(0, {
        isSidechain: true,
        tools: [tool("Read", { file_path: "secret.txt" }, "secret")],
      }),
      step(1, { text: "main turn" }),
      step(2, { tools: [tool("Read", { file_path: "src/target.ts" })] }),
    ]);

    const built = buildReplayRequest(withSidechain, 2, 100_000);
    expect(messageText(built)).not.toContain("secret.txt");
    expect(messageText(built)).toContain("main turn");
  });

  it("refuses a sidechain target", () => {
    expect(() =>
      buildReplayRequest(
        session([step(0, { isSidechain: true })]),
        0,
        10_000,
      ),
    ).toThrow(/sidechain/);
  });

  it("drops the oldest turns until the context budget fits", () => {
    const turns = Array.from({ length: 30 }, (_, index) =>
      step(index, { text: `turn-${index} ${"x".repeat(400)}` }),
    );
    const target = step(30, {
      tools: [tool("Read", { file_path: "src/target.ts" })],
    });
    const longSession = session([...turns, target], "Task: fix it.");

    const full = buildReplayRequest(longSession, 30, 1_000_000);
    const small = buildReplayRequest(longSession, 30, 400);

    expect(small.messages.length).toBeLessThan(full.messages.length);
    expect(small.messages.length).toBeGreaterThan(2);
    expect(small.messages[1]).toEqual({
      role: "user",
      content: "Task: fix it.",
    });
    expect(estimate(small)).toBeLessThanOrEqual(400);
    expect(messageText(small)).toContain("turn-29");
    expect(messageText(small)).not.toContain("turn-0 ");
    expect(messageText(small)).not.toContain("src/target.ts");
  });

  it("keeps user prompts and drops older tool output first when trimming", () => {
    const largeOutput = "Z".repeat(3_000);
    const trimmedSession = session([
      step(0, {
        userText: "first prompt",
        tools: [tool("Read", { file_path: "src/a.ts" }, largeOutput)],
      }),
      step(1, {
        userText: "second prompt",
        tools: [tool("Bash", { command: "npm test" }, "all green")],
      }),
      step(2, { tools: [tool("Read", { file_path: "src/target.ts" })] }),
    ]);

    const full = buildReplayRequest(trimmedSession, 2, 100_000);
    expect(messageText(full)).toContain(largeOutput.slice(0, 100));

    const trimmed = buildReplayRequest(trimmedSession, 2, 200);
    const userMessages = trimmed.messages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages.map((message) => message.content)).toEqual([
      "first prompt",
      "second prompt",
    ]);
    // The oldest tool exchange is gone before any user prompt is dropped.
    expect(messageText(trimmed)).not.toContain(largeOutput.slice(0, 100));
    expect(estimate(trimmed)).toBeLessThanOrEqual(200);
  });

  it("rejects an out-of-range step index", () => {
    expect(() => buildReplayRequest(session([]), 0, 10_000)).toThrow(
      /out of range/,
    );
  });

  it("includes every user prompt, with the latest as the most recent user message", () => {
    const dir = mkdtempSync(join(tmpdir(), "downshift-replay-context-"));
    tempDirs.push(dir);
    const path = join(dir, "transcript.jsonl");

    const userLine = (text: string, second: number): string =>
      JSON.stringify({
        type: "user",
        sessionId: "sess-prompts",
        timestamp: `2026-10-26T13:00:0${second}.000Z`,
        message: { role: "user", content: text },
      });
    const assistantLine = (id: string, second: number): string =>
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-prompts",
        timestamp: `2026-10-26T13:00:0${second}.000Z`,
        message: {
          id,
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: `reply to ${id}` }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      });

    writeFileSync(
      path,
      [
        userLine("first prompt", 0),
        assistantLine("msg_one", 1),
        userLine("second prompt", 2),
        assistantLine("msg_two", 3),
        userLine("third prompt", 4),
        assistantLine("msg_three", 5),
      ].join("\n"),
      "utf8",
    );

    const parsed = parseClaudeCodeTranscript(path);
    expect(parsed.steps).toHaveLength(3);

    // Replay the assistant turn that answered the third prompt.
    const built = buildReplayRequest(parsed, 2, 100_000);
    const userMessages = built.messages.filter(
      (message) => message.role === "user",
    );
    expect(userMessages.map((message) => message.content)).toEqual([
      "first prompt",
      "second prompt",
      "third prompt",
    ]);
    expect(userMessages[userMessages.length - 1]?.content).toBe("third prompt");
  });
});

describe("sampleSteps", () => {
  const replayableSession = session([
    ...Array.from({ length: 10 }, (_, index) =>
      step(index, {
        kind: "read",
        tools: [tool("Read", { file_path: `src/f${index}.ts` })],
      }),
    ),
    ...Array.from({ length: 5 }, (_, offset) =>
      step(10 + offset, {
        kind: "edit",
        tools: [
          tool("Edit", {
            file_path: `src/e${offset}.ts`,
            old_string: "a",
            new_string: "b",
          }),
        ],
      }),
    ),
    step(15, {
      kind: "read",
      isSidechain: true,
      tools: [tool("Read", { file_path: "sidechain.ts" })],
    }),
    step(16, {
      kind: "other",
      tools: [tool("Task", { prompt: "do it" })],
    }),
    step(17, { kind: "plan", text: "I will edit a file." }),
  ]);

  it("caps samples per kind", () => {
    const sampled = sampleSteps(replayableSession, 3, 42);
    const byKind = new Map<string, number>();
    for (const entry of sampled) {
      byKind.set(entry.kind, (byKind.get(entry.kind) ?? 0) + 1);
    }
    expect(byKind.get("read")).toBe(3);
    expect(byKind.get("edit")).toBe(3);
    expect(byKind.get("plan")).toBe(1);
  });

  it("is deterministic for the same seed", () => {
    expect(sampleSteps(replayableSession, 3, 42)).toEqual(
      sampleSteps(replayableSession, 3, 42),
    );
  });

  it("varies the selection with the seed", () => {
    const first = sampleSteps(replayableSession, 3, 42).filter(
      (entry) => entry.kind === "read",
    );
    const second = sampleSteps(replayableSession, 3, 43).filter(
      (entry) => entry.kind === "read",
    );
    expect(first).not.toEqual(second);
  });

  it("returns every candidate when the group is below the cap", () => {
    const edits = sampleSteps(replayableSession, 10, 7).filter(
      (entry) => entry.kind === "edit",
    );
    expect(edits.map((entry) => entry.stepIndex)).toEqual([
      10, 11, 12, 13, 14,
    ]);
  });

  it("skips sidechain and non-replayable steps", () => {
    const sampled = sampleSteps(replayableSession, 20, 42);
    const indices = sampled.map((entry) => entry.stepIndex);
    expect(indices).not.toContain(15);
    expect(indices).not.toContain(16);
    expect(indices).toContain(17);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  it("returns nothing at a zero cap", () => {
    expect(sampleSteps(replayableSession, 0, 42)).toEqual([]);
  });
});
