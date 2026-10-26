import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseClaudeCodeTranscript } from "../src/ingest/claude-code.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/claude-code.jsonl", import.meta.url),
);

const tempDirs: string[] = [];

function writeTempTranscript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "downshift-ingest-"));
  tempDirs.push(dir);
  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseClaudeCodeTranscript", () => {
  const session = parseClaudeCodeTranscript(fixturePath);

  it("reads session metadata and ignores junk line types", () => {
    expect(session.id).toBe("sess-downshift-001");
    expect(session.source).toBe("claude-code");
    expect(session.cwd).toBe("/tmp/downshift-demo");
    expect(session.path).toBe(fixturePath);
    // attachment, system, file-history-snapshot, custom-title, queue-operation,
    // the invalid trailing JSON line, and the plain user prompt all produce no step.
    expect(session.steps).toHaveLength(3);
    expect(session.steps.map((step) => step.id)).toEqual([
      "msg_01AAA",
      "msg_01BBB",
      "msg_01CCC",
    ]);
    expect(session.steps.map((step) => step.index)).toEqual([0, 1, 2]);
  });

  it("merges blocks from lines sharing a message id and counts usage once", () => {
    const merged = session.steps[0];
    expect(merged).toBeDefined();
    if (!merged) throw new Error("expected a merged step");

    expect(merged.model).toBe("claude-sonnet-4-5");
    expect(merged.startedAt).toBe(Date.parse("2026-10-26T09:00:02.000Z"));
    expect(merged.isSidechain).toBe(false);

    // Text from the first and third split lines, thinking block dropped.
    expect(merged.text).toBe(
      "I'll start by reading the config.\nNow the tests.",
    );
    expect(merged.text).not.toContain("I should read the config file first.");

    // Three lines each report the same usage; it must not be summed to 300.
    expect(merged.tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      reasoning: 0,
    });

    expect(merged.tools.map((tool) => tool.name)).toEqual(["Read", "Bash"]);
    expect(merged.tools[0]?.input).toEqual({
      file_path: "/tmp/downshift-demo/package.json",
    });
    expect(merged.tools[1]?.input).toEqual({ command: "npm test" });
  });

  it("attaches later tool_result lines to the matching tool call", () => {
    const merged = session.steps[0];
    const second = session.steps[1];
    expect(merged).toBeDefined();
    expect(second).toBeDefined();
    if (!merged || !second) throw new Error("expected two steps");

    expect(merged.tools[0]?.output).toBe('{"name":"downshift"}');
    expect(merged.tools[1]?.output).toBe(
      '[{"type":"text","text":"Test Files 1 passed"}]',
    );
    expect(second.tools[0]?.output).toBe(
      '{"stdout":" M src/cli.ts","exitCode":0}',
    );
  });

  it("keeps sidechain flags and per-message tokens", () => {
    expect(session.steps.map((step) => step.isSidechain)).toEqual([
      false,
      false,
      true,
    ]);
    expect(session.steps[2]?.tokens).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(session.steps[2]?.text).toBe("Sidechain note.");
  });

  it("truncates oversized tool output to 4000 chars", () => {
    const longOutput = "x".repeat(5000);
    const path = writeTempTranscript([
      JSON.stringify({
        type: "assistant",
        sessionId: "sess-truncate",
        timestamp: "2026-10-26T10:00:00.000Z",
        message: {
          id: "msg_trunc",
          model: "claude-sonnet-4-5",
          content: [
            { type: "tool_use", id: "toolu_big", name: "Bash", input: {} },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId: "sess-truncate",
        timestamp: "2026-10-26T10:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_big", content: longOutput },
          ],
        },
      }),
    ]);

    const parsed = parseClaudeCodeTranscript(path);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps[0]?.tools[0]?.output).toHaveLength(4000);
  });

  it("tolerates an empty transcript", () => {
    const parsed = parseClaudeCodeTranscript(writeTempTranscript([]));
    expect(parsed.steps).toEqual([]);
    expect(parsed.id).toBe("transcript");
  });
});