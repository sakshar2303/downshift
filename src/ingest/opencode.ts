import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session, Step, Tokens, ToolCall } from "../types.js";

/** Tool results are clipped so a single huge output can't dominate a session. */
const MAX_TOOL_OUTPUT_CHARS = 4000;

/** Alan Code (the OpenCode engine inside Alan) and plain OpenCode keep separate DBs. */
export function opencodeDbPaths(): string[] {
  return [
    join(homedir(), ".alan", "alan-code", "engine", "share", "opencode", "opencode.db"),
    join(homedir(), ".local", "share", "opencode", "opencode.db"),
  ];
}

export interface OpencodeSessionSummary {
  id: string;
  title?: string;
  path: string;
  updatedAt: number;
  stepCount: number;
  totalTokens: number;
}

type Row = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toMillis(value: unknown): number {
  // OpenCode stores epoch milliseconds in every time_* column.
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : 0;
}

function emptyTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function readTokens(value: unknown): Tokens {
  if (!isRecord(value)) return emptyTokens();
  const count = (source: Record<string, unknown>, key: string): number => {
    const raw = source[key];
    return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  };
  const cache = isRecord(value.cache) ? value.cache : {};
  return {
    input: count(value, "input"),
    output: count(value, "output"),
    cacheRead: count(cache, "read"),
    cacheWrite: count(cache, "write"),
    reasoning: count(value, "reasoning"),
  };
}

function addTokens(target: Tokens, source: Tokens): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
}

function totalTokens(tokens: Tokens): number {
  return (
    tokens.input +
    tokens.output +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.reasoning
  );
}

function parseJson(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringifyToolOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const raw =
    typeof output === "string"
      ? output
      : (JSON.stringify(output) ?? String(output));
  return raw.length > MAX_TOOL_OUTPUT_CHARS
    ? raw.slice(0, MAX_TOOL_OUTPUT_CHARS)
    : raw;
}

/**
 * Copy the live database (plus its WAL sidecars) into a temp dir and open the
 * copy read-only. Reading the original DB directly would take SQLite locks and
 * could disturb an Alan Code / OpenCode process that is still running.
 */
function withCopiedDatabase<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  if (!existsSync(dbPath)) {
    throw new Error(`OpenCode database not found: ${dbPath}`);
  }

  const dir = mkdtempSync(join(tmpdir(), "downshift-opencode-"));
  const copyPath = join(dir, "opencode.db");
  try {
    copyFileSync(dbPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${dbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${copyPath}${suffix}`);
    }

    const db = new DatabaseSync(copyPath, { readOnly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Segment {
  id: string;
  startedAt: number;
  tokens?: Tokens;
  cost?: number;
  tools: ToolCall[];
  texts: string[];
}

interface SessionRow {
  id: string;
  title?: string;
  directory?: string;
  model?: string;
  updatedAt: number;
}

function readSessionRow(row: Row): SessionRow {
  return {
    id: asString(row.id) ?? "unknown",
    title: asString(row.title) || undefined,
    directory: asString(row.directory) || undefined,
    model: asString(row.model) || undefined,
    updatedAt: toMillis(row.time_updated),
  };
}

function buildSession(
  db: DatabaseSync,
  row: SessionRow,
  dbPath: string,
): Session {
  const model = parseJson(row.model);
  const fallbackModel = asString(model?.id) ?? "";
  const fallbackProvider = asString(model?.providerID);

  const messages = db
    .prepare(
      "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    )
    .all(row.id) as Row[];

  const partsByMessage = new Map<string, Row[]>();
  const parts = db
    .prepare(
      "SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC",
    )
    .all(row.id) as Row[];

  for (const part of parts) {
    const messageId = asString(part.message_id);
    if (messageId === undefined) continue;
    const bucket = partsByMessage.get(messageId);
    if (bucket === undefined) partsByMessage.set(messageId, [part]);
    else bucket.push(part);
  }

  const steps: Step[] = [];
  let firstUserMessage: string | undefined;

  for (const message of messages) {
    const messageId = asString(message.id);
    if (messageId === undefined) continue;

    const data = parseJson(message.data);

    if (data?.role === "user") {
      if (firstUserMessage === undefined) {
        const texts: string[] = [];
        for (const part of partsByMessage.get(messageId) ?? []) {
          const partData = parseJson(part.data);
          if (partData?.type !== "text") continue;
          const text = asString(partData.text);
          if (text !== undefined && text.trim() !== "") texts.push(text);
        }
        if (texts.length > 0) firstUserMessage = texts.join("\n").trim();
      }
      continue;
    }

    if (data?.role !== "assistant") continue;

    const messageTokens = readTokens(data.tokens);
    const modelId = asString(data.modelID) ?? fallbackModel;
    const providerId = asString(data.providerID) ?? fallbackProvider;
    const messageStartedAt = toMillis(message.time_created);

    const messageParts = partsByMessage.get(messageId) ?? [];
    let current: Segment | undefined;
    let segmentIndex = 0;

    const openSegment = (startedAt: number, id: string): Segment => {
      const segment: Segment = {
        id,
        startedAt,
        tools: [],
        texts: [],
      };
      segmentIndex += 1;
      return segment;
    };

    const closeSegment = (segment: Segment): void => {
      // Alan-hosted usage records cost 0 on the step, so cost is always
      // recomputed later from the resolved pricing table.
      steps.push({
        id: segment.id,
        index: steps.length,
        sessionId: row.id,
        source: "opencode",
        model: modelId,
        provider: providerId,
        startedAt: segment.startedAt,
        tools: segment.tools,
        text: segment.texts.length > 0 ? segment.texts.join("\n") : undefined,
        tokens: segment.tokens ?? messageTokens,
        recordedCostUsd: segment.cost,
        isSidechain: false,
      });
    };

    for (const part of messageParts) {
      const partData = parseJson(part.data);
      if (partData === undefined) continue;
      const partId = asString(part.id) ?? `${messageId}:${segmentIndex}`;
      const partAt = toMillis(part.time_created);

      switch (partData.type) {
        case "step-start": {
          if (current !== undefined) closeSegment(current);
          current = openSegment(partAt, partId);
          break;
        }
        case "step-finish": {
          if (current === undefined) {
            current = openSegment(partAt, partId);
          }
          current.tokens = readTokens(partData.tokens);
          const cost = partData.cost;
          current.cost =
            typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
          closeSegment(current);
          current = undefined;
          break;
        }
        case "tool": {
          if (current === undefined) {
            current = openSegment(partAt, `${messageId}:${segmentIndex}`);
          }
          const state = isRecord(partData.state) ? partData.state : {};
          const callId = asString(partData.callID);
          const name = asString(partData.tool);
          if (callId === undefined || name === undefined) break;

          const call: ToolCall = {
            id: callId,
            name,
            input: state.input ?? {},
          };
          const output = stringifyToolOutput(state.output);
          if (output !== undefined) call.output = output;
          current.tools.push(call);
          break;
        }
        case "text": {
          const text = asString(partData.text);
          if (text === undefined) break;
          if (current === undefined) {
            current = openSegment(partAt, `${messageId}:${segmentIndex}`);
          }
          current.texts.push(text);
          break;
        }
        case "reasoning": {
          // Reasoning is not part of the replayable step text.
          break;
        }
        default:
          break;
      }
    }

    if (current !== undefined) closeSegment(current);
  }

  return {
    id: row.id,
    source: "opencode",
    title: row.title,
    firstUserMessage,
    path: dbPath,
    cwd: row.directory,
    steps,
  };
}

function readSessionRows(db: DatabaseSync): SessionRow[] {
  const rows = db
    .prepare(
      "SELECT id, title, directory, model, time_created, time_updated FROM session ORDER BY time_updated DESC, id ASC",
    )
    .all() as Row[];
  return rows.map(readSessionRow);
}

/** List every session in an OpenCode database, newest first. */
export function listOpencodeSessions(dbPath: string): OpencodeSessionSummary[] {
  return withCopiedDatabase(dbPath, (db) => {
    const summaries: OpencodeSessionSummary[] = [];
    for (const row of readSessionRows(db)) {
      const session = buildSession(db, row, dbPath);
      const totals = emptyTokens();
      for (const step of session.steps) addTokens(totals, step.tokens);
      summaries.push({
        id: session.id,
        title: session.title,
        path: dbPath,
        updatedAt: row.updatedAt,
        stepCount: session.steps.length,
        totalTokens: totalTokens(totals),
      });
    }
    return summaries;
  });
}

/** Load one OpenCode session, segmenting its assistant turns into steps. */
export function loadOpencodeSession(
  dbPath: string,
  sessionId: string,
): Session | undefined {
  return withCopiedDatabase(dbPath, (db) => {
    const row = db
      .prepare(
        "SELECT id, title, directory, model, time_created, time_updated FROM session WHERE id = ?",
      )
      .get(sessionId) as Row | undefined;
    if (row === undefined) return undefined;
    return buildSession(db, readSessionRow(row), dbPath);
  });
}