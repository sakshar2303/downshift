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

/**
 * Test runners and type checks. Kept as a literal so classification is stable
 * and auditable; the outer word boundaries keep "tsc" from matching "tsconfig".
 */
export const TEST_COMMAND_PATTERN =
  /\b(vitest|jest|pytest|mocha|go test|cargo test|(npm|pnpm|yarn|bun)( run)? test|tsc( --noEmit)?|playwright test)\b/;

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

function classifyTool(tool: ToolCall): StepKind {
  const name = toolName(tool);

  if (EDIT_TOOLS.has(name)) return "edit";
  if (SHELL_TOOLS.has(name)) {
    const command = commandOf(tool);
    return command !== undefined && TEST_COMMAND_PATTERN.test(command)
      ? "test"
      : "shell";
  }
  if (name === "task") return "delegate";
  if (WEB_TOOLS.has(name)) return "web";
  if (SEARCH_TOOLS.has(name)) return "search";
  if (READ_TOOLS.has(name)) return "read";
  return "other";
}

/** Classify a step from its tool calls alone — no model calls, no heuristics. */
export function classifyStep(step: Step): StepKind {
  const tools = step.tools;
  if (tools.length === 0) return "plan";
  if (tools.some((tool) => PLAN_TOOLS.has(toolName(tool)))) return "plan";

  let best: StepKind = "other";
  let bestRank = KIND_PRIORITY.length;

  for (const tool of tools) {
    const kind = classifyTool(tool);
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
