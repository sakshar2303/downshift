import type { Step, StepKind, ToolCall } from "../types.js";

/**
 * When a step calls several tools, the most consequential one names the step.
 * "other" is deliberately last: an unrecognised MCP tool should not outrank a
 * real read or edit.
 */
const KIND_PRIORITY: StepKind[] = [
  "edit",
  "test",
  "shell",
  "delegate",
  "web",
  "search",
  "read",
  "other",
];

const READ_TOOLS = new Set(["read", "view", "notebookread"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "ls", "list", "find"]);
const WEB_TOOLS = new Set(["webfetch", "websearch", "web_search"]);
const EDIT_TOOLS = new Set([
  "edit",
  "multiedit",
  "write",
  "notebookedit",
  "patch",
]);
const SHELL_TOOLS = new Set(["bash", "execute"]);
const PLAN_TOOLS = new Set(["todowrite", "exitplanmode"]);

/** Program names whose whole job is dumping file contents to stdout. */
const READ_PROGRAMS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "nl",
  "bat",
  "file",
  "stat",
]);

/** Program names whose whole job is locating or filtering content. */
const SEARCH_PROGRAMS = new Set(["grep", "rg", "ag", "find", "fd", "ls", "tree"]);

/** git subcommands that only inspect history or the working tree. */
const GIT_READ_SUBCOMMANDS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "grep",
  "blame",
]);

/** Package-manager scripts that run the test/lint/type-check toolchain. */
const PACKAGE_TEST_SCRIPTS = new Set(["test", "typecheck", "lint"]);

/**
 * Test runners and type checks. Kept as a literal so classification is stable
 * and auditable; the outer word boundaries keep "tsc" from matching "tsconfig".
 */
export const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|mocha|go test|cargo test|(npm|pnpm|yarn|bun)( run)? test|tsc( --noEmit)?|playwright test)\b/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

function toolName(tool: ToolCall): string {
  return tool.name.trim().toLowerCase();
}

function commandOf(tool: ToolCall): string | undefined {
  const input = tool.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : undefined;
}

function isShellTool(tool: ToolCall): boolean {
  return SHELL_TOOLS.has(toolName(tool));
}

function stripQuotes(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'[^']*'/g, " ");
}

/**
 * Split a shell command on &&, ||, ; and | while ignoring separators inside
 * single or double quotes. This is not a shell parser, just enough structure to
 * classify each pipeline stage independently.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote !== undefined) {
      current += char;
      if (char === "\\" && quote === '"') {
        index += 1;
        current += command[index] ?? "";
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }

    const two = command.slice(index, index + 2);
    if (two === "&&" || two === "||") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }

    if (char === ";" || char === "|") {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

/** Remove leading `FOO=bar` assignments from a segment. */
function stripEnvAssignments(segment: string): string {
  let remaining = segment.trim();
  while (ENV_ASSIGNMENT.test(remaining)) {
    remaining = remaining.replace(ENV_ASSIGNMENT, "");
  }
  return remaining.trim();
}

function firstWord(token: string): string {
  return token.replace(/^["']|["']$/g, "").split("/").pop() ?? token;
}

function hasOutputRedirection(segment: string): boolean {
  // Ignore quoted text, and fd duplication such as 2>&1 or >&2.
  const unquoted = stripQuotes(segment);
  return />>|<</.test(unquoted) || /(?<![&])>(?!&)/.test(unquoted);
}

function commandWords(segment: string): string[] {
  return stripEnvAssignments(segment).split(/\s+/).filter(Boolean);
}

function firstNonFlag(args: string[]): string | undefined {
  return args.find((arg) => !arg.startsWith("-"));
}

function classifyGit(args: string[]): StepKind {
  const subcommand = firstNonFlag(args)?.toLowerCase();
  return subcommand !== undefined && GIT_READ_SUBCOMMANDS.has(subcommand)
    ? "search"
    : "shell";
}

function classifyPackageManager(args: string[]): StepKind {
  const subcommand = firstNonFlag(args)?.toLowerCase();
  if (subcommand === "run") {
    const script = firstNonFlag(args.slice(args.indexOf("run") + 1))?.toLowerCase();
    return script !== undefined && PACKAGE_TEST_SCRIPTS.has(script)
      ? "test"
      : "shell";
  }
  return subcommand === "test" ? "test" : "shell";
}

function classifyNpx(args: string[]): StepKind {
  const binary = firstNonFlag(args)?.toLowerCase();
  if (
    binary === "tsc" ||
    binary === "vitest" ||
    binary === "jest" ||
    binary === "pytest" ||
    binary === "mocha"
  ) {
    return "test";
  }
  if (
    binary === "playwright" &&
    args.some((arg) => arg.toLowerCase() === "test")
  ) {
    return "test";
  }
  return "shell";
}

function classifySed(args: string[]): StepKind {
  // `sed -n 1,80p f` reads; `sed -i ...` rewrites the file in place.
  const inPlace = args.some((arg) => /^-[a-zA-Z]*i/.test(arg));
  return inPlace ? "shell" : "read";
}

/** Classify a single pipeline stage by the work its program does. */
export function classifyCommandSegment(segment: string): StepKind {
  const trimmed = stripEnvAssignments(segment);
  if (trimmed === "") return "other";

  if (hasOutputRedirection(trimmed)) return "shell";

  const words = commandWords(trimmed);
  const program = firstWord(words[0] ?? "").toLowerCase();
  const args = words.slice(1);

  // Program first: `grep -rn vitest src` searches for "vitest", it does not run
  // the test suite. Only command runners are checked against the test pattern.
  if (READ_PROGRAMS.has(program)) return "read";
  if (program === "sed") return classifySed(args);
  if (SEARCH_PROGRAMS.has(program)) return "search";
  if (program === "git") return classifyGit(args);
  if (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun") {
    return classifyPackageManager(args);
  }
  if (program === "npx") return classifyNpx(args);

  const unquoted = stripQuotes(trimmed);
  if (TEST_COMMAND_PATTERN.test(unquoted)) return "test";
  return "shell";
}

/**
 * Classify a bash/execute command by its stages, then take the highest-priority
 * kind. `cat f && git status` is a search; `git add && git commit` is shell.
 */
export function classifyShellCommand(command: string): StepKind {
  let segments = splitCommandSegments(command)
    .map(stripEnvAssignments)
    .filter((segment) => segment !== "");

  // A leading `cd` only sets context for the real command; it is not work.
  while (segments.length > 0) {
    const program = firstWord(segments[0]?.split(/\s+/)[0] ?? "").toLowerCase();
    if (program !== "cd") break;
    segments = segments.slice(1);
  }

  if (segments.length === 0) return "shell";

  let best: StepKind = "other";
  let bestRank = KIND_PRIORITY.length;
  for (const segment of segments) {
    const kind = classifyCommandSegment(segment);
    const rank = KIND_PRIORITY.indexOf(kind);
    if (rank < bestRank) {
      best = kind;
      bestRank = rank;
    }
  }
  return best;
}

/** Classify one tool call. Shell tools inspect their command text. */
export function classifyToolCall(tool: ToolCall): StepKind {
  const name = toolName(tool);

  if (EDIT_TOOLS.has(name)) return "edit";
  if (isShellTool(tool)) {
    const command = commandOf(tool);
    return command === undefined ? "shell" : classifyShellCommand(command);
  }
  if (name === "task") return "delegate";
  if (WEB_TOOLS.has(name)) return "web";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (READ_TOOLS.has(name)) return "read";
  return "other";
}

/** Number of bash/execute calls and how many were really reads/searches/tests. */
export function summarizeShellCalls(steps: Step[]): {
  total: number;
  informative: number;
} {
  let total = 0;
  let informative = 0;

  for (const step of steps) {
    for (const tool of step.tools) {
      if (!isShellTool(tool)) continue;
      total += 1;
      const kind = classifyToolCall(tool);
      if (kind === "read" || kind === "search" || kind === "test") {
        informative += 1;
      }
    }
  }

  return { total, informative };
}

/** Classify a step from its tool calls alone — no model calls, no heuristics. */
export function classifyStep(step: Step): StepKind {
  const tools = step.tools;
  if (tools.length === 0) return "plan";

  // Plan tools only define the step when they are the only thing it did.
  const workTools = tools.filter((tool) => !PLAN_TOOLS.has(toolName(tool)));
  if (workTools.length === 0) return "plan";

  let best: StepKind = "other";
  let bestRank = KIND_PRIORITY.length;

  for (const tool of workTools) {
    const kind = classifyToolCall(tool);
    const rank = KIND_PRIORITY.indexOf(kind);
    if (rank < bestRank) {
      best = kind;
      bestRank = rank;
    }
  }

  return best;
}

/** Classify every step in place. */
export function classifySteps(steps: Step[]): void {
  for (const step of steps) step.kind = classifyStep(step);
}