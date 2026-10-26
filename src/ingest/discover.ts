import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Session, Step } from "../types.js";
import { parseClaudeCodeTranscript } from "./claude-code.js";
import { listOpencodeSessions, opencodeDbPaths } from "./opencode.js";

const UNTITLED = "(untitled)";

export type SourceFilter = Session["source"];

export interface DiscoveredSession {
  id: string;
  source: Session["source"];
  title: string;
  path: string;
  stepCount: number;
  totalTokens: number;
  updatedAt: number;
}

export interface ResolvedTarget {
  id: string;
  source: Session["source"];
  path: string;
  title?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stepTokens(steps: Step[]): number {
  let total = 0;
  for (const step of steps) {
    total +=
      step.tokens.input +
      step.tokens.output +
      step.tokens.cacheRead +
      step.tokens.cacheWrite +
      step.tokens.reasoning;
  }
  return total;
}

/** Read the newest timestamp from a transcript. */
function readClaudeUpdatedAt(path: string): number {
  let updatedAt = 0;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const timestamp = asString(parsed.timestamp);
    if (timestamp !== undefined) {
      const millis = Date.parse(timestamp);
      if (Number.isFinite(millis) && millis > updatedAt) updatedAt = millis;
    }
  }

  if (updatedAt === 0) {
    try {
      updatedAt = Math.round(statSync(path).mtimeMs);
    } catch {
      updatedAt = 0;
    }
  }

  return updatedAt;
}

function discoverClaudeCodeSessions(): DiscoveredSession[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  const found: DiscoveredSession[] = [];

  let projectDirs: Dirent[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dirPath = join(projectsDir, projectDir.name);

    let files: Dirent[];
    try {
      files = readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith(".jsonl")) continue;
      const path = join(dirPath, file.name);
      try {
        const session = parseClaudeCodeTranscript(path);
        found.push({
          id: basename(file.name).replace(/\.jsonl$/i, ""),
          source: "claude-code",
          title: session.title ?? UNTITLED,
          path,
          stepCount: session.steps.length,
          totalTokens: stepTokens(session.steps),
          updatedAt: readClaudeUpdatedAt(path),
        });
      } catch {
        // An unreadable or half-written transcript should not hide the rest.
        continue;
      }
    }
  }

  return found;
}

function discoverOpencodeSessions(): DiscoveredSession[] {
  const found: DiscoveredSession[] = [];
  for (const dbPath of opencodeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    try {
      for (const session of listOpencodeSessions(dbPath)) {
        found.push({
          id: session.id,
          source: "opencode",
          title: session.title ?? UNTITLED,
          path: dbPath,
          stepCount: session.stepCount,
          totalTokens: session.totalTokens,
          updatedAt: session.updatedAt,
        });
      }
    } catch {
      // A locked or corrupt DB should not hide sessions from other sources.
      continue;
    }
  }
  return found;
}

/**
 * Map a user-facing source name to an ingest source. "alan" is the Alan Code
 * app, which runs on the OpenCode engine and writes the same database format.
 */
export function normalizeSource(value: string): SourceFilter | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "opencode" || normalized === "alan") return "opencode";
  if (normalized === "claude-code" || normalized === "claude") {
    return "claude-code";
  }
  return undefined;
}

/** Every recorded session on this machine, newest first. */
export function discoverSessions(filter?: SourceFilter): DiscoveredSession[] {
  const all = [...discoverClaudeCodeSessions(), ...discoverOpencodeSessions()];
  const filtered =
    filter === undefined ? all : all.filter((session) => session.source === filter);
  return filtered.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  );
}

function findOpencodeSession(sessionId: string): ResolvedTarget | undefined {
  for (const dbPath of opencodeDbPaths()) {
    if (!existsSync(dbPath)) continue;
    try {
      const match = listOpencodeSessions(dbPath).find(
        (session) => session.id === sessionId,
      );
      if (match !== undefined) {
        return {
          id: match.id,
          source: "opencode",
          path: dbPath,
          title: match.title,
        };
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function resolveLatest(filter?: SourceFilter): ResolvedTarget {
  const latest = discoverSessions(filter)[0];
  if (latest === undefined) {
    const scope = filter === undefined ? "" : ` for source "${filter}"`;
    throw new Error(`No recorded sessions found${scope}.`);
  }
  return {
    id: latest.id,
    source: latest.source,
    path: latest.path,
    title: latest.title,
  };
}

/**
 * Resolve a CLI target: a transcript path, an OpenCode session id, "latest", or
 * "latest:<source>" to pick the newest session from one source only.
 */
export function resolveTarget(target: string): ResolvedTarget {
  if (target === "latest") return resolveLatest();

  if (target.startsWith("latest:")) {
    const requested = target.slice("latest:".length);
    const filter = normalizeSource(requested);
    if (filter === undefined) {
      throw new Error(
        `Unknown source "${requested}". Expected alan, opencode, or claude-code.`,
      );
    }
    return resolveLatest(filter);
  }

  const isPath = target.toLowerCase().endsWith(".jsonl") || existsSync(target);
  if (isPath) {
    const path = resolve(target);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Transcript not found: ${target}`);
    }
    return {
      id: basename(path).replace(/\.jsonl$/i, ""),
      source: "claude-code",
      path,
    };
  }

  const opencode = findOpencodeSession(target);
  if (opencode !== undefined) return opencode;

  throw new Error(
    `Could not resolve session "${target}". Expected a .jsonl transcript path, an OpenCode session id, "latest", or "latest:<source>".`,
  );
}