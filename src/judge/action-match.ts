import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";
import {
  classifyCommandSegment,
  splitCommandSegments,
} from "../classify/kinds.js";
import type { CanonicalAction, CanonicalToolName } from "../replay/tools.js";

/** A replay response can be a tool call, free text, or nothing at all. */
export type JudgedAction = CanonicalAction | { text: string } | null;

/** A replay "matches" the original action at or above this score. */
export const MATCH_THRESHOLD = 0.8;

/** Two related tools are a weak match even though their names differ. */
const NEAR_MISS_TOOLS: ReadonlyArray<
  readonly [CanonicalToolName, CanonicalToolName]
> = [["search", "list_files"]];

const NEAR_MISS_SCORE = 0.3;

/** Longest slice of a file edit compared with Levenshtein. */
const MAX_EDIT_LENGTH = 4_000;

function isToolAction(action: JudgedAction): action is CanonicalAction {
  return action !== null && "tool" in action;
}

function toolOf(action: JudgedAction): CanonicalToolName | undefined {
  return isToolAction(action) ? action.tool : undefined;
}

function argsOf(action: JudgedAction): Record<string, unknown> {
  if (!isToolAction(action)) return {};
  const args = action.args;
  return typeof args === "object" && args !== null
    ? (args as Record<string, unknown>)
    : {};
}

function stringArg(
  action: JudgedAction,
  keys: string[],
): string | undefined {
  const args = argsOf(action);
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize a transcript path for comparison: forward slashes, "./" stripped,
 * relative paths resolved against the session cwd, trailing slashes removed.
 */
export function normalizePath(input: string, cwd: string): string {
  let candidate = input.trim().replace(/\\/g, "/");
  while (candidate.startsWith("./")) candidate = candidate.slice(2);
  candidate = candidate.replace(/\/+$/, "");
  if (candidate === "") candidate = ".";

  const absolute = isAbsolute(candidate)
    ? normalize(candidate)
    : resolve(cwd, candidate);
  return absolute.replace(/\\/g, "/");
}

/** Split text on non-word characters and lowercase, for Jaccard similarity. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token !== "");
}

export function jaccard(left: string[], right: string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 && b.size === 0) return 1;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/** Levenshtein edit distance with O(min(n,m)) memory. */
export function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  // Iterate over the longer string on the outside so the working row is the
  // shorter one, which keeps allocations small for big file edits.
  const a = left.length >= right.length ? left : right;
  const b = left.length >= right.length ? right : left;

  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let column = 0; column <= b.length; column += 1) previous[column] = column;

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    const char = a[row - 1];
    for (let column = 1; column <= b.length; column += 1) {
      const substitution = (previous[column - 1] ?? 0) + (char === b[column - 1] ? 0 : 1);
      const deletion = (previous[column] ?? 0) + 1;
      const insertion = (current[column - 1] ?? 0) + 1;
      current[column] = Math.min(substitution, deletion, insertion);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** 1 for identical strings, 0 when every character differs. */
export function normalizedLevenshtein(left: string, right: string): number {
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (longest === 0) return 1;
  return clamp01(1 - levenshtein(left, right) / longest);
}

function scoreReadFile(replayed: JudgedAction, original: JudgedAction, cwd: string): number {
  const replayedPath = stringArg(replayed, ["path", "file_path"]);
  const originalPath = stringArg(original, ["path", "file_path"]);
  if (replayedPath === undefined || originalPath === undefined) return 0;

  const target = normalizePath(originalPath, cwd);
  const actual = normalizePath(replayedPath, cwd);
  if (target === actual) return 1;
  return dirname(target) === dirname(actual) ? 0.5 : 0;
}

function scopeOf(action: JudgedAction, cwd: string): string {
  return normalizePath(stringArg(action, ["path", "file_path"]) ?? ".", cwd);
}

function scoreSearch(replayed: JudgedAction, original: JudgedAction, cwd: string): number {
  const replayedPattern = stringArg(replayed, ["pattern", "query"]);
  const originalPattern = stringArg(original, ["pattern", "query"]);
  if (replayedPattern === undefined || originalPattern === undefined) return 0;

  const patternScore =
    0.8 *
    jaccard(tokenize(originalPattern), tokenize(replayedPattern));
  const scopeScore = scopeOf(original, cwd) === scopeOf(replayed, cwd) ? 0.2 : 0;
  return clamp01(patternScore + scopeScore);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function executableOf(command: string): string | undefined {
  const first = normalizeCommand(command).split(" ")[0];
  if (first === undefined || first === "") return undefined;
  const unquoted = first.replace(/^["']|["']$/g, "");
  return basename(unquoted);
}

function scoreRunCommand(replayed: JudgedAction, original: JudgedAction): number {
  const replayedCommand = stringArg(replayed, ["command"]);
  const originalCommand = stringArg(original, ["command"]);
  if (replayedCommand === undefined || originalCommand === undefined) return 0;

  const expected = normalizeCommand(originalCommand);
  const actual = normalizeCommand(replayedCommand);
  if (expected === actual) return 1;

  const expectedExecutable = executableOf(expected);
  const actualExecutable = executableOf(actual);
  if (
    expectedExecutable === undefined ||
    actualExecutable === undefined ||
    expectedExecutable !== actualExecutable
  ) {
    return 0;
  }

  const expectedArgs = tokenize(expected.split(" ").slice(1).join(" "));
  const actualArgs = tokenize(actual.split(" ").slice(1).join(" "));
  return clamp01(0.5 + 0.5 * jaccard(expectedArgs, actualArgs));
}

function newTextOf(action: JudgedAction): string | undefined {
  return (
    stringArg(action, ["new_string", "newString", "content", "text"]) ??
    undefined
  );
}

function scoreEdit(replayed: JudgedAction, original: JudgedAction, cwd: string): number {
  const replayedPath = stringArg(replayed, ["path", "file_path"]);
  const originalPath = stringArg(original, ["path", "file_path"]);
  if (replayedPath === undefined || originalPath === undefined) return 0;

  const samePath =
    normalizePath(originalPath, cwd) === normalizePath(replayedPath, cwd);
  const expectedText = (newTextOf(original) ?? "").slice(0, MAX_EDIT_LENGTH);
  const actualText = (newTextOf(replayed) ?? "").slice(0, MAX_EDIT_LENGTH);

  return clamp01(
    (samePath ? 0.5 : 0) + 0.5 * normalizedLevenshtein(expectedText, actualText),
  );
}

function scoreListFiles(replayed: JudgedAction, original: JudgedAction, cwd: string): number {
  const replayedPath = stringArg(replayed, ["path"]);
  const originalPath = stringArg(original, ["path"]);
  if (replayedPath === undefined || originalPath === undefined) return 0;
  return normalizePath(originalPath, cwd) === normalizePath(replayedPath, cwd)
    ? 1
    : 0;
}

/** Shell programs whose single-segment use is really reading one file. */
const SHELL_READ_PROGRAMS = new Set(["cat", "head", "tail", "nl", "less", "sed"]);

/** Shell programs whose single-segment use is a content search. */
const SHELL_SEARCH_PROGRAMS = new Set(["grep", "rg"]);

/** Shell programs whose single-segment use lists a directory. */
const SHELL_LIST_PROGRAMS = new Set(["ls", "find", "tree"]);

/** Options that consume the following word, per read program. */
const READ_OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  cat: new Set(),
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "--lines", "--bytes"]),
  nl: new Set(["-b", "-h", "-f", "-v", "-i", "-l", "-w", "-s"]),
  less: new Set(["-P", "--prompt"]),
  sed: new Set(["-e", "-f", "--expression", "--file"]),
};

const NO_OPTIONS: ReadonlySet<string> = new Set();

const SEARCH_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-A", "-B", "-C", "-D", "-d", "-f", "-g", "-m", "-t",
  "--after-context", "--before-context", "--context", "--directory",
  "--exclude", "--exclude-dir", "--file", "--glob", "--include",
  "--max-count", "--type", "--type-not",
]);

const LIST_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-A", "-D", "-I", "-L", "-O", "-P", "-w",
  "--filelimit", "--timeout",
  "-name", "-iname", "-path", "-ipath", "-type", "-maxdepth", "-mindepth",
  "-size", "-perm", "-user", "-group", "-newer", "-regex", "-iregex",
]);

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Redirection tokens such as `2>/dev/null` or `2>&1` are not arguments. */
const REDIRECTION = /^\d*[<>]/;

/** Split one shell segment into words, honouring quoted strings. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string;

    if (quote !== undefined) {
      if (char === "\\" && quote === '"') {
        const next = segment[index + 1];
        if (next !== undefined) {
          current += next;
          index += 1;
        }
      } else if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) words.push(current);
  return words;
}

/** Program and arguments of a segment, without leading `FOO=bar` assignments. */
function programWords(segment: string): string[] {
  const words = shellWords(segment);
  let start = 0;
  while (start < words.length && ENV_ASSIGNMENT.test(words[start] as string)) {
    start += 1;
  }
  return words.slice(start);
}

function programOf(words: string[]): string {
  return basename(words[0] ?? "").toLowerCase();
}

function isCdSegment(segment: string): boolean {
  return programOf(programWords(segment)) === "cd";
}

/**
 * Positional words of a command, skipping flags and the values of flags that
 * take one. `head -n 40 f` yields `f`; `sed -n 1,80p f` yields the script and
 * then `f`.
 */
function positionals(
  args: string[],
  optionsWithValue: ReadonlySet<string>,
): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === "--") {
      values.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (optionsWithValue.has(arg)) index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function readPathOf(args: string[], program: string): string | undefined {
  const values = positionals(
    args,
    READ_OPTIONS_WITH_VALUE[program] ?? NO_OPTIONS,
  );
  // The file is last: `sed -n '1,80p' f` and `head -n 40 f` both end in it.
  return values[values.length - 1];
}

function parseSearchArgs(
  args: string[],
): { pattern: string; path?: string } | undefined {
  let pattern: string | undefined;
  let path: string | undefined;

  const addPositional = (value: string): void => {
    if (pattern === undefined) pattern = value;
    else if (path === undefined) path = value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === "--") {
      for (const value of args.slice(index + 1)) addPositional(value);
      break;
    }
    if (arg === "-e" || arg === "--regexp") {
      const value = args[index + 1];
      if (value !== undefined) {
        pattern ??= value;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--regexp=")) {
      pattern ??= arg.slice("--regexp=".length);
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      pattern ??= arg.slice(2);
      continue;
    }
    if (arg.startsWith("-")) {
      if (SEARCH_OPTIONS_WITH_VALUE.has(arg)) index += 1;
      continue;
    }
    addPositional(arg);
  }

  if (pattern === undefined) return undefined;
  return path === undefined ? { pattern } : { pattern, path };
}

/**
 * Rewrite a shell command that only reads, searches or lists files into the
 * canonical tool a replay model would call for the same work. Anything more
 * complex — pipelines, writes, test runs — stays a shell command.
 */
export function canonicalizeShellCommand(
  command: string,
): CanonicalAction | undefined {
  let segments = splitCommandSegments(command);
  // `cd dir && cat f` is a read of f; the cd only sets the shell's context.
  while (segments.length > 0 && isCdSegment(segments[0] as string)) {
    segments = segments.slice(1);
  }
  if (segments.length !== 1) return undefined;

  const segment = segments[0] as string;
  const kind = classifyCommandSegment(segment);
  if (kind !== "read" && kind !== "search") return undefined;

  const words = programWords(segment);
  const program = programOf(words);
  const args = words.slice(1).filter((word) => !REDIRECTION.test(word));

  if (kind === "read" && SHELL_READ_PROGRAMS.has(program)) {
    const path = readPathOf(args, program);
    return path === undefined
      ? undefined
      : { tool: "read_file", args: { path } };
  }

  if (kind === "search" && SHELL_SEARCH_PROGRAMS.has(program)) {
    const parsed = parseSearchArgs(args);
    return parsed === undefined ? undefined : { tool: "search", args: parsed };
  }

  if (kind === "search" && SHELL_LIST_PROGRAMS.has(program)) {
    return {
      tool: "list_files",
      args: { path: positionals(args, LIST_OPTIONS_WITH_VALUE)[0] ?? "." },
    };
  }

  return undefined;
}

/** Compare shell actions by what they do, not by the tool name they use. */
export function canonicalizeAction(action: JudgedAction): JudgedAction {
  if (!isToolAction(action) || action.tool !== "run_command") return action;
  const command = stringArg(action, ["command"]);
  if (command === undefined) return action;
  return canonicalizeShellCommand(command) ?? action;
}

/**
 * Deterministically score how closely a replayed action reproduces the
 * original one. Returns 0 for plan steps (text), which the LLM judge scores
 * instead, and for a replay that produced no tool call.
 */
export function score(
  replayed: JudgedAction,
  original: JudgedAction,
  cwd: string,
): number {
  const actual = canonicalizeAction(replayed);
  const expected = canonicalizeAction(original);
  if (!isToolAction(actual) || !isToolAction(expected)) return 0;

  const replayedTool = actual.tool;
  const originalTool = expected.tool;

  if (replayedTool !== originalTool) {
    const nearMiss = NEAR_MISS_TOOLS.some(
      ([a, b]) =>
        (a === replayedTool && b === originalTool) ||
        (a === originalTool && b === replayedTool),
    );
    return nearMiss ? NEAR_MISS_SCORE : 0;
  }

  switch (replayedTool) {
    case "read_file":
      return scoreReadFile(actual, expected, cwd);
    case "search":
      return scoreSearch(actual, expected, cwd);
    case "list_files":
      return scoreListFiles(actual, expected, cwd);
    case "run_command":
      return scoreRunCommand(actual, expected);
    case "edit_file":
    case "write_file":
      return scoreEdit(actual, expected, cwd);
    default:
      // finish has no comparable arguments; only an identical finish matches.
      return 1;
  }
}

/** True when a score clears the replay match threshold. */
export function isMatch(value: number): boolean {
  return value >= MATCH_THRESHOLD;
}