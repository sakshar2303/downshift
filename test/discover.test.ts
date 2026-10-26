import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// discover.ts and opencode.ts resolve their DB roots from homedir() at call
// time, so a fake home lets us test source filtering without touching real
// sessions on this machine.
const mocks = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mocks.home };
});

import { discoverSessions, resolveTarget } from "../src/ingest/discover.js";

const tempDirs: string[] = [];

function writeClaudeTranscript(home: string): string {
  const dir = join(home, ".claude", "projects", "-tmp-project");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "sess-claude.jsonl");
  const lines = [
    JSON.stringify({
      type: "user",
      sessionId: "sess-claude",
      timestamp: "2026-10-26T12:00:00.000Z",
      message: { role: "user", content: "Claude prompt" },
    }),
    JSON.stringify({
      type: "custom-title",
      sessionId: "sess-claude",
      customTitle: "Renamed Claude session",
      timestamp: "2026-10-26T12:00:01.000Z",
    }),
  ];
  writeFileSync(path, lines.join("\n"), "utf8");
  return path;
}

function writeOpencodeDb(home: string): string {
  const dir = join(
    home,
    ".alan",
    "alan-code",
    "engine",
    "share",
    "opencode",
  );
  mkdirSync(dir, { recursive: true });
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
  db.prepare(
    "INSERT INTO session (id, title, directory, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "ses_alan",
    "Alan Code session",
    "/tmp/alan",
    JSON.stringify({ id: "deepseek/deepseek-v4.1-flash", providerID: "alan" }),
    1000,
    2000,
  );
  db.close();
  return dbPath;
}

beforeAll(() => {
  const home = mkdtempSync(join(tmpdir(), "downshift-discover-"));
  tempDirs.push(home);
  mocks.home = home;
  writeClaudeTranscript(home);
  writeOpencodeDb(home);
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("discoverSessions", () => {
  it("reuses the parser's title logic for Claude Code sessions", () => {
    const sessions = discoverSessions("claude-code");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title).toBe("Renamed Claude session");
  });

  it("filters by source", () => {
    expect(discoverSessions("opencode").map((session) => session.id)).toEqual([
      "ses_alan",
    ]);
    expect(discoverSessions()).toHaveLength(2);
  });
});

describe("resolveTarget", () => {
  it("resolves latest across all sources", () => {
    const target = resolveTarget("latest");
    expect(target.source).toBe("claude-code");
    expect(target.id).toBe("sess-claude");
  });

  it("resolves latest:alan to the newest OpenCode session", () => {
    const target = resolveTarget("latest:alan");
    expect(target).toEqual({
      id: "ses_alan",
      source: "opencode",
      path: join(
        mocks.home,
        ".alan",
        "alan-code",
        "engine",
        "share",
        "opencode",
        "opencode.db",
      ),
      title: "Alan Code session",
    });
  });

  it("resolves latest:opencode and latest:claude-code", () => {
    expect(resolveTarget("latest:opencode").id).toBe("ses_alan");
    expect(resolveTarget("latest:claude-code").id).toBe("sess-claude");
  });

  it("rejects an unknown source", () => {
    expect(() => resolveTarget("latest:gemini")).toThrow(/Unknown source/);
  });
});
