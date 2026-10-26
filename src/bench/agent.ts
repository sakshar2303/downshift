import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  classifyShellCommand,
  splitCommandSegments,
} from "../classify/kinds.js";
import {
  chat,
  type ChatMessage,
  type ChatResult,
} from "../providers/index.js";
import { canonicalTools, type CanonicalToolName } from "../replay/tools.js";
import type { StepKind, Tokens } from "../types.js";

export const DEFAULT_MAX_STEPS = 30;
export const COMMAND_TIMEOUT_MS = 60_000;
export const COMMAND_OUTPUT_LIMIT = 1_500;
export const READ_OUTPUT_LIMIT = 6_000;
export const TEXT_ONLY_NUDGE =
  "Use a tool to continue, or call finish with a summary if the task is done.";
export const MALFORMED_TOOL_CALL_NUDGE =
  "Your last tool call had invalid JSON arguments. Call the tool again with valid JSON.";

const EMPTY_TOKENS: Tokens = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** Commands the benchmark agent may run, matched at a word boundary. */
export const ALLOWED_COMMAND_PREFIXES = [
  "npm test",
  "npx vitest run",
  "ls",
  "cat",
  "grep",
  "node -e",
] as const;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".downshift",
  "dist",
  "coverage",
]);

const TEST_COMMAND =
  /\b(vitest|jest|pytest|mocha|go test|cargo test|(npm|pnpm|yarn|bun)( run)? test|playwright test)\b/;

export interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export interface SandboxOptions {
  root: string;
  commandTimeoutMs?: number;
  outputLimit?: number;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (truncated)`;
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** True when the command redirects stdin or stdout outside quotes. */
function hasRedirection(command: string): boolean {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (quote !== undefined) {
      if (char === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">" || char === "<") return true;
  }
  return false;
}

/**
 * Find shell control characters outside quotes. These let a command escape the
 * prefix allow-list by chaining another command.
 */
function unquotedControlIndex(command: string): number {
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (quote !== undefined) {
      // Double quotes still allow command substitution and backticks.
      if (quote === '"' && char === "$" && command[index + 1] === "(") {
        return index;
      }
      if (quote === '"' && char === "`") return index;
      if (char === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (";&|`<>".includes(char)) return index;
    if (char === "$" && command[index + 1] === "(") return index;
    if (char === "\n" || char === "\r") return index;
  }
  return -1;
}

function tokensOutsideQuotes(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";

    if (quote !== undefined) {
      if (char === "\\" && quote === '"') {
        index += 1;
        current += command[index] ?? "";
        continue;
      }
      if (char === quote) {
        quote = undefined;
        continue;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function hasEscapingToken(command: string): boolean {
  for (const token of tokensOutsideQuotes(command)) {
    if (token.startsWith("/")) return true;
    if (token.split("/").includes("..")) return true;
  }
  return false;
}

/** True when the command starts with an allow-listed prefix. */
export function isCommandAllowed(command: string): boolean {
  const normalized = normalizeCommand(command);
  if (normalized === "") return false;
  if (unquotedControlIndex(normalized) !== -1) return false;
  if (hasEscapingToken(normalized)) return false;

  return ALLOWED_COMMAND_PREFIXES.some(
    (prefix) =>
      normalized === prefix || normalized.startsWith(`${prefix} `),
  );
}

/** True when a command invokes a test runner. */
export function runsTests(command: string): boolean {
  return TEST_COMMAND.test(command);
}

function kindForTool(name: string, args: Record<string, unknown>): StepKind {
  switch (name) {
    case "read_file":
      return "read";
    case "search":
    case "list_files":
      return "search";
    case "edit_file":
    case "write_file":
      return "edit";
    case "run_command": {
      const command = typeof args.command === "string" ? args.command : "";
      return command === "" ? "shell" : classifyShellCommand(command);
    }
    default:
      return "other";
  }
}

/**
 * A directory-confined tool sandbox. Every path is resolved against the temp
 * task copy and rejected if it escapes; commands are prefix-allow-listed,
 * time-limited and output-truncated.
 */
export class Sandbox {
  readonly root: string;
  private readonly commandTimeoutMs: number;
  private readonly outputLimit: number;

  constructor(options: SandboxOptions) {
    this.root = resolve(options.root);
    this.commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    this.outputLimit = options.outputLimit ?? COMMAND_OUTPUT_LIMIT;
  }

  resolvePath(input: string): string {
    const candidate = input.trim() === "" ? "." : input.trim();
    const absolute = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(this.root, candidate);
    const rel = relative(this.root, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Path escapes the task directory: ${input}`);
    }
    return absolute;
  }

  private display(absolute: string): string {
    return relative(this.root, absolute).split(sep).join("/") || ".";
  }

  async runCommand(rawCommand: string): Promise<CommandResult> {
    const command = normalizeCommand(rawCommand);
    if (!isCommandAllowed(command)) {
      throw new Error(
        `Command is not allowed in the benchmark sandbox: ${command}`,
      );
    }

    return await new Promise<CommandResult>((done) => {
      exec(
        command,
        {
          cwd: this.root,
          timeout: this.commandTimeoutMs,
          maxBuffer: 2_000_000,
          shell: "/bin/sh",
        },
        (error, stdout, stderr) => {
          const combined = `${stdout}${stderr}`.trim();
          const timedOut =
            error !== null &&
            (error.killed === true ||
              (error as NodeJS.ErrnoException).code === "ETIMEDOUT");
          const exitCode =
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1;
          done({
            exitCode,
            output: truncate(combined === "" ? "(no output)" : combined, this.outputLimit),
            timedOut,
          });
        },
      );
    });
  }

  private readFile(path: string): string {
    const absolute = this.resolvePath(path);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(`File not found: ${path}`);
    }
    return truncate(readFileSync(absolute, "utf8"), READ_OUTPUT_LIMIT);
  }

  private listFiles(path: string): string {
    const absolute = this.resolvePath(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`Directory not found: ${path}`);
    }
    const entries = readdirSync(absolute, { withFileTypes: true })
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort();
    return entries.join("\n") || "(empty directory)";
  }

  private search(pattern: string, scope: string): string {
    let matcher: RegExp;
    try {
      matcher = new RegExp(pattern, "i");
    } catch {
      matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    }

    const start = this.resolvePath(scope);
    const matches: string[] = [];

    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (matches.length >= 100) return;
        if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;

        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;

        let stat;
        try {
          stat = statSync(absolute);
        } catch {
          continue;
        }
        if (stat.size > 200_000) continue;

        let content: string;
        try {
          content = readFileSync(absolute, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;

        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!matcher.test(line)) continue;
          matches.push(`${this.display(absolute)}:${index + 1}: ${line.trim()}`);
          if (matches.length >= 100) return;
        }
      }
    };

    if (statSync(start).isDirectory()) walk(start);
    else {
      const content = readFileSync(start, "utf8");
      content.split(/\r?\n/).forEach((line, index) => {
        if (matcher.test(line)) {
          matches.push(`${this.display(start)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    return matches.length === 0
      ? "(no matches)"
      : truncate(matches.join("\n"), READ_OUTPUT_LIMIT * 2);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "read_file": {
        const path = args.path;
        if (typeof path !== "string") throw new Error("read_file needs a path");
        return this.readFile(path);
      }
      case "list_files": {
        const path = typeof args.path === "string" ? args.path : ".";
        return this.listFiles(path);
      }
      case "search": {
        const pattern = args.pattern;
        if (typeof pattern !== "string") {
          throw new Error("search needs a pattern");
        }
        const scope = typeof args.path === "string" ? args.path : ".";
        return this.search(pattern, scope);
      }
      case "edit_file": {
        const path = typeof args.path === "string" ? args.path : "";
        const oldString =
          typeof args.old_string === "string" ? args.old_string : "";
        const newString =
          typeof args.new_string === "string" ? args.new_string : "";
        if (path === "" || oldString === "") {
          throw new Error("edit_file needs path and old_string");
        }
        const absolute = this.resolvePath(path);
        if (!existsSync(absolute)) throw new Error(`File not found: ${path}`);
        const content = readFileSync(absolute, "utf8");
        if (!content.includes(oldString)) {
          throw new Error(`old_string was not found in ${path}`);
        }
        writeFileSync(absolute, content.replace(oldString, newString), "utf8");
        return `Edited ${this.display(absolute)}`;
      }
      case "write_file": {
        const path = typeof args.path === "string" ? args.path : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (path === "") throw new Error("write_file needs a path");
        const absolute = this.resolvePath(path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, content, "utf8");
        return `Wrote ${this.display(absolute)} (${content.length} bytes)`;
      }
      case "run_command": {
        const command = args.command;
        if (typeof command !== "string") {
          throw new Error("run_command needs a command");
        }
        const result = await this.runCommand(command);
        return `exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n${result.output}`;
      }
      default:
        throw new Error(`Unknown sandbox tool: ${name}`);
    }
  }
}

export interface ProposedAction {
  tool: string;
  args: Record<string, unknown>;
}

/** Parse the first canonical tool call out of a model response. */
export function proposedAction(
  result: ChatResult,
): ProposedAction | undefined {
  const call = result.message.tool_calls?.[0];
  if (call === undefined) return undefined;
  let args: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    args = {};
  }
  return { tool: call.function.name, args };
}

/**
 * The speculative accept rule: cheap read/search/list calls and test runs are
 * safe to take from the small model; edits, writes, other commands and finish
 * escalate to the big model.
 */
export function acceptsDownshift(action: ProposedAction | undefined): boolean {
  if (action === undefined) return false;
  if (
    action.tool === "read_file" ||
    action.tool === "search" ||
    action.tool === "list_files"
  ) {
    return true;
  }
  if (action.tool === "run_command") {
    const command = action.args.command;
    if (typeof command !== "string") return false;
    return (
      splitCommandSegments(command).length === 1 &&
      !hasRedirection(command) &&
      classifyShellCommand(command) === "test"
    );
  }
  return false;
}

export interface BenchCallRecord {
  modelRef: string;
  tokens: Tokens;
  latencyMs: number;
}

export interface BenchStepRecord {
  step: number;
  /** Model whose response was used. */
  modelRef: string;
  tool: string;
  kind: StepKind;
  tokens: Tokens;
  latencyMs: number;
  /** Every model call in this step (two when a proposal escalated). */
  calls: BenchCallRecord[];
  escalated: boolean;
  /** Set when the provider failed and the step could not produce a response. */
  error?: string;
}

export interface StepContext {
  step: number;
  taskDir: string;
  lastTool?: string;
  messages: ChatMessage[];
  history: BenchStepRecord[];
}

export type ModelChooser = (
  context: StepContext,
) => string | Promise<string>;

export interface AgentOptions {
  /** Source task folder; it is copied to a temp directory before running. */
  taskDir: string;
  chooseModel: ModelChooser;
  /** Model to ask when the first proposal is not accepted. */
  speculativeFallback?: string;
  /** Defaults to acceptsDownshift when speculativeFallback is set. */
  acceptProposal?: (action: ProposedAction | undefined) => boolean;
  maxSteps?: number;
  /** Install dependencies in the temp copy once (default true). */
  install?: boolean;
  /** Injectable chat client, for tests. */
  chatFn?: (modelRef: string, options: Parameters<typeof chat>[1]) => Promise<ChatResult>;
  onStep?: (record: BenchStepRecord) => void;
  sandbox?: Sandbox;
}

export interface AgentRunResult {
  steps: BenchStepRecord[];
  finished: boolean;
  summary?: string;
  tempDir: string;
  escalatedSteps: number;
}

export interface PreparedTask {
  tempDir: string;
  sandbox: Sandbox;
}

/** Copy a task folder to a fresh temp dir, excluding build and install state. */
export function createTempTaskCopy(taskDir: string): string {
  const source = resolve(taskDir);
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error(`Benchmark task directory not found: ${taskDir}`);
  }

  const temp = mkdtempSync(join(tmpdir(), "downshift-bench-"));
  cpSync(source, temp, {
    recursive: true,
    filter: (entry) => {
      const name = basename(entry);
      return !SKIP_DIRS.has(name) && name !== ".git";
    },
  });
  return temp;
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((done, fail) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 10_000_000 },
      (error, stdout, stderr) => {
        if (error === null) {
          done();
          return;
        }
        const detail = `${stdout}${stderr}`.trim().slice(0, 2_000);
        fail(
          new Error(
            `${command} ${args.join(" ")} failed: ${detail || error.message}`,
          ),
        );
      },
    );
  });
}

/** Install task dependencies in the temp copy. */
export async function installDependencies(
  tempDir: string,
  timeoutMs = 300_000,
): Promise<void> {
  await runProcess(
    "npm",
    ["install", "--no-audit", "--no-fund"],
    tempDir,
    timeoutMs,
  );
}

export async function prepareTask(
  taskDir: string,
  options: { install?: boolean } = {},
): Promise<PreparedTask> {
  const tempDir = createTempTaskCopy(taskDir);
  if (options.install !== false) await installDependencies(tempDir);
  return { tempDir, sandbox: new Sandbox({ root: tempDir }) };
}

function systemPrompt(taskDir: string, task: string): string {
  const files = readdirSync(taskDir)
    .filter((name) => !SKIP_DIRS.has(name))
    .sort()
    .join(", ");

  return [
    "You are a coding agent solving a small benchmark task in a temporary copy of a TypeScript project.",
    "Use the provided tools to inspect and change files. Read before editing, keep changes focused, and run the tests.",
    "Never edit test files. When the task is complete, call finish with a short summary.",
    "Tools: read_file, search, list_files, edit_file, write_file, run_command, finish.",
    `Working files: ${files}.`,
    "",
    "TASK:",
    task,
  ].join("\n");
}

function tokensFromUsage(usage: ChatResult["usage"]): Tokens {
  const prompt = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, prompt - cached),
    output: usage?.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0,
    // Reasoning tokens are already included in completion_tokens.
    reasoning: 0,
  };
}

function callRecord(result: ChatResult, modelRef: string): BenchCallRecord {
  return {
    modelRef,
    tokens: tokensFromUsage(result.usage),
    latencyMs: result.latencyMs,
  };
}

/**
 * Groq answers 400 when a model emits tool arguments that are not valid JSON.
 * The call is worth one more try because the model can correct itself when told.
 */
function isMalformedToolCallError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as Record<string, unknown>).status !== 400) return false;
  const message =
    error instanceof Error
      ? error.message
      : String((error as Record<string, unknown>).message ?? "");
  return /failed to parse tool call arguments as json/i.test(message);
}

/**
 * Run a minimal tool-calling agent loop against a fresh temp copy of a task.
 *
 * The model is chosen per step. When `speculativeFallback` is set, the chosen
 * (small) model answers first; only an accepted read/search/list/test proposal
 * is used, otherwise the fallback big model answers and both calls count.
 * Stops on finish or after `maxSteps` (default 30).
 */
export async function runBenchAgent(
  options: AgentOptions,
): Promise<AgentRunResult> {
  const prepared = await prepareTask(options.taskDir, {
    install: options.install,
  });
  const sandbox = options.sandbox ?? prepared.sandbox;
  const chatFn = options.chatFn ?? chat;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const accept = options.acceptProposal ?? acceptsDownshift;

  const taskPath = join(prepared.tempDir, "TASK.md");
  const task = existsSync(taskPath)
    ? readFileSync(taskPath, "utf8").trim()
    : "(no TASK.md found)";

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(prepared.tempDir, task) },
    { role: "user", content: task },
  ];

  const steps: BenchStepRecord[] = [];
  let finished = false;
  let summary: string | undefined;
  let escalatedSteps = 0;
  let lastTool: string | undefined;
  let textOnlyReplies = 0;

  const request: Parameters<typeof chat>[1] = {
    messages,
    tools: canonicalTools,
    toolChoice: "auto",
    temperature: 0,
    maxTokens: 2_048,
  };

  const callModel = async (modelRef: string): Promise<ChatResult> => {
    try {
      return await chatFn(modelRef, request);
    } catch (error) {
      if (!isMalformedToolCallError(error)) throw error;
      messages.push({ role: "user", content: MALFORMED_TOOL_CALL_NUDGE });
      return await chatFn(modelRef, request);
    }
  };

  for (let step = 1; step <= maxSteps && !finished; step += 1) {
    const selectedModel = await options.chooseModel({
      step,
      taskDir: prepared.tempDir,
      lastTool,
      messages: [...messages],
      history: steps,
    });

    let first: ChatResult;
    let result: ChatResult;
    let modelRef = selectedModel;
    let escalated = false;
    const calls: BenchCallRecord[] = [];

    try {
      first = await callModel(selectedModel);
      result = first;
      calls.push(callRecord(first, selectedModel));
      if (options.speculativeFallback !== undefined) {
        const proposal = proposedAction(first);
        if (!accept(proposal)) {
          escalated = true;
          escalatedSteps += 1;
          result = await callModel(options.speculativeFallback);
          modelRef = options.speculativeFallback;
          calls.push(callRecord(result, modelRef));
        }
      }
    } catch (error) {
      // Other provider errors still abort the run; only the malformed-JSON 400
      // is safe to skip because the step produced no action to execute.
      if (!isMalformedToolCallError(error)) throw error;
      const record: BenchStepRecord = {
        step,
        modelRef: selectedModel,
        tool: "error",
        kind: "other",
        tokens: EMPTY_TOKENS,
        latencyMs: 0,
        calls,
        escalated,
        error: error instanceof Error ? error.message : String(error),
      };
      steps.push(record);
      lastTool = record.tool;
      options.onStep?.(record);
      continue;
    }

    const assistant = result.message;
    messages.push({
      role: "assistant",
      content: assistant.content ?? null,
      ...(assistant.tool_calls !== undefined
        ? { tool_calls: assistant.tool_calls }
        : {}),
    });

    const toolCalls = assistant.tool_calls ?? [];
    const usedCall = calls[calls.length - 1] as BenchCallRecord;
    const firstTool = toolCalls[0]?.function.name ?? "text";
    let parsedArgs: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(
        toolCalls[0]?.function.arguments ?? "{}",
      );
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      }
    } catch {
      parsedArgs = {};
    }

    const record: BenchStepRecord = {
      step,
      modelRef,
      tool: firstTool,
      kind: kindForTool(firstTool, parsedArgs),
      tokens: usedCall.tokens,
      latencyMs: usedCall.latencyMs,
      calls,
      escalated,
    };
    steps.push(record);
    lastTool = firstTool;

    if (toolCalls.length === 0) {
      textOnlyReplies += 1;
      if (textOnlyReplies === 1) {
        messages.push({ role: "user", content: TEXT_ONLY_NUDGE });
      } else {
        finished = true;
      }
      options.onStep?.(record);
      if (finished) break;
      continue;
    }
    textOnlyReplies = 0;

    for (const call of toolCalls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || "{}");
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }

      let output: string;
      if (name === "finish") {
        finished = true;
        summary = typeof args.summary === "string" ? args.summary : "";
        output = "Task finished.";
      } else {
        try {
          output = await sandbox.execute(name, args);
        } catch (error) {
          output = `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output,
      });

      if (name === "finish") break;
    }

    options.onStep?.(record);
  }

  return {
    steps,
    finished,
    ...(summary !== undefined ? { summary } : {}),
    tempDir: prepared.tempDir,
    escalatedSteps,
  };
}

/** sha256 hashes for every file under the task's test directory. */
export function hashTestFiles(taskDir: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const testDir = join(taskDir, "test");
  if (!existsSync(testDir)) return hashes;

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(taskDir, absolute).split(sep).join("/");
      const hash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      hashes.set(relativePath, hash);
    }
  };

  walk(testDir);
  return hashes;
}

export function testFilesUnchanged(
  before: Map<string, string>,
  after: Map<string, string>,
): boolean {
  if (before.size !== after.size) return false;
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) return false;
  }
  return true;
}

/** Run `npm test` in a task directory and capture its exit code. */
export async function runTaskTests(
  taskDir: string,
): Promise<{ exitCode: number; output: string }> {
  return await new Promise((done) => {
    exec(
      "npm test",
      {
        cwd: taskDir,
        timeout: 120_000,
        maxBuffer: 5_000_000,
        shell: "/bin/sh",
      },
      (error, stdout, stderr) => {
        done({
          exitCode:
            error === null
              ? 0
              : typeof error.code === "number"
                ? error.code
                : 1,
          output: `${stdout}${stderr}`.trim().slice(0, 4_000),
        });
      },
    );
  });
}