import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  listOpencodeSessions,
  loadOpencodeSession,
} from "../src/ingest/opencode.js";

const tempDirs: string[] = [];

function createSyntheticDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "downshift-opencode-test-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      model TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
  `);

  const sessionId = "ses_synthetic";
  db.prepare(
    "INSERT INTO session (id, title, directory, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    "Synthetic session",
    "/tmp/synthetic",
    JSON.stringify({
      id: "deepseek/deepseek-v4.1-flash",
      providerID: "alan",
    }),
    1000,
    3000,
  );

  const insertMessage = db.prepare(
    "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
  );
  const insertPart = db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
  );

  const assistantData = (tokens: unknown): string =>
    JSON.stringify({
      role: "assistant",
      modelID: "deepseek/deepseek-v4.1-flash",
      providerID: "alan",
      tokens,
      cost: 0,
      time: { created: 1000, completed: 3000 },
    });

  insertMessage.run(
    "msg_a",
    sessionId,
    1000,
    assistantData({
      input: 260,
      output: 52,
      reasoning: 5,
      total: 317,
      cache: { read: 50, write: 10 },
    }),
  );

  // Message A contains two step-start..step-finish segments.
  insertPart.run("p_a1", "msg_a", sessionId, 1001, JSON.stringify({ type: "step-start" }));
  insertPart.run(
    "p_a2",
    "msg_a",
    sessionId,
    1002,
    JSON.stringify({ type: "text", text: "Reading the config." }),
  );
  insertPart.run(
    "p_a3",
    "msg_a",
    sessionId,
    1003,
    JSON.stringify({
      type: "tool",
      tool: "read",
      callID: "call_1",
      state: {
        status: "completed",
        input: { filePath: "/tmp/synthetic/package.json" },
        output: { name: "downshift" },
        title: "Read package.json",
      },
    }),
  );
  insertPart.run(
    "p_a4",
    "msg_a",
    sessionId,
    1004,
    JSON.stringify({
      type: "step-finish",
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 50, write: 10 },
      },
      cost: 0,
      reason: "end",
    }),
  );
  insertPart.run("p_a5", "msg_a", sessionId, 1005, JSON.stringify({ type: "step-start" }));
  insertPart.run(
    "p_a6",
    "msg_a",
    sessionId,
    1006,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call_2",
      state: {
        status: "completed",
        input: { command: "npm test" },
        output: "Test Files 1 passed",
      },
    }),
  );
  insertPart.run(
    "p_a7",
    "msg_a",
    sessionId,
    1007,
    JSON.stringify({
      type: "step-finish",
      tokens: {
        input: 150,
        output: 30,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      reason: "end",
    }),
  );

  insertMessage.run(
    "msg_b",
    sessionId,
    2000,
    assistantData({
      input: 10,
      output: 5,
      reasoning: 2,
      total: 17,
      cache: { read: 0, write: 0 },
    }),
  );

  // Message B contains one segment, with reasoning that must not leak into text.
  insertPart.run("p_b1", "msg_b", sessionId, 2001, JSON.stringify({ type: "step-start" }));
  insertPart.run(
    "p_b2",
    "msg_b",
    sessionId,
    2002,
    JSON.stringify({ type: "reasoning", text: "Checking the test output." }),
  );
  insertPart.run(
    "p_b3",
    "msg_b",
    sessionId,
    2003,
    JSON.stringify({ type: "text", text: "All tests pass." }),
  );
  insertPart.run(
    "p_b4",
    "msg_b",
    sessionId,
    2004,
    JSON.stringify({
      type: "tool",
      tool: "bash",
      callID: "call_3",
      state: {
        status: "completed",
        input: { command: "git status" },
        output: "x".repeat(5000),
      },
    }),
  );
  insertPart.run(
    "p_b5",
    "msg_b",
    sessionId,
    2005,
    JSON.stringify({
      type: "step-finish",
      tokens: {
        input: 10,
        output: 5,
        reasoning: 2,
        cache: { read: 0, write: 0 },
      },
      cost: 0,
      reason: "end",
    }),
  );

  db.close();
  return dbPath;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadOpencodeSession", () => {
  const dbPath = createSyntheticDb();
  const session = loadOpencodeSession(dbPath, "ses_synthetic");

  it("reads session metadata", () => {
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("expected a session");

    expect(session.id).toBe("ses_synthetic");
    expect(session.source).toBe("opencode");
    expect(session.title).toBe("Synthetic session");
    expect(session.path).toBe(dbPath);
    expect(session.cwd).toBe("/tmp/synthetic");
  });

  it("splits assistant messages into one step per step segment", () => {
    if (session === undefined) throw new Error("expected a session");
    expect(session.steps).toHaveLength(3);
    expect(session.steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(session.steps.map((step) => step.sessionId)).toEqual([
      "ses_synthetic",
      "ses_synthetic",
      "ses_synthetic",
    ]);
    expect(session.steps.map((step) => step.model)).toEqual([
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
    ]);
    expect(session.steps.map((step) => step.provider)).toEqual([
      "alan",
      "alan",
      "alan",
    ]);
    expect(session.steps.map((step) => step.startedAt)).toEqual([
      1001, 1005, 2001,
    ]);
  });

  it("takes tokens and cost from each step-finish", () => {
    if (session === undefined) throw new Error("expected a session");
    expect(session.steps[0]?.tokens).toEqual({
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 10,
      reasoning: 5,
    });
    expect(session.steps[1]?.tokens).toEqual({
      input: 150,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(session.steps[2]?.tokens).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 2,
    });
    expect(session.steps.map((step) => step.recordedCostUsd)).toEqual([0, 0, 0]);
  });

  it("collects tool calls and text per segment", () => {
    if (session === undefined) throw new Error("expected a session");

    expect(session.steps[0]?.text).toBe("Reading the config.");
    expect(session.steps[0]?.tools).toEqual([
      {
        id: "call_1",
        name: "read",
        input: { filePath: "/tmp/synthetic/package.json" },
        output: '{"name":"downshift"}',
      },
    ]);

    expect(session.steps[1]?.text).toBeUndefined();
    expect(session.steps[1]?.tools).toEqual([
      {
        id: "call_2",
        name: "bash",
        input: { command: "npm test" },
        output: "Test Files 1 passed",
      },
    ]);

    // Reasoning parts are not step text, and oversized output is clipped.
    expect(session.steps[2]?.text).toBe("All tests pass.");
    expect(session.steps[2]?.tools.map((tool) => tool.name)).toEqual(["bash"]);
    expect(session.steps[2]?.tools[0]?.output).toHaveLength(4000);
  });

  it("returns undefined for an unknown session", () => {
    expect(loadOpencodeSession(dbPath, "ses_missing")).toBeUndefined();
  });
});

describe("listOpencodeSessions", () => {
  it("summarizes sessions with step and token counts", () => {
    const dbPath = createSyntheticDb();
    const sessions = listOpencodeSessions(dbPath);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      id: "ses_synthetic",
      title: "Synthetic session",
      path: dbPath,
      updatedAt: 3000,
      stepCount: 3,
      totalTokens: 382,
    });
  });
});