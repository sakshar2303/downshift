import type { ChatTool } from "../providers/index.js";
import type { ToolCall } from "../types.js";

export type CanonicalToolName =
  | "read_file"
  | "search"
  | "list_files"
  | "edit_file"
  | "write_file"
  | "run_command"
  | "finish";

export interface CanonicalAction {
  tool: CanonicalToolName;
  args: Record<string, unknown>;
}

/** The only tools a replay is allowed to call, in OpenAI function format. */
export const canonicalTools: ChatTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repository.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Repository-relative path." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search file contents or names for a pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Optional scope to search." },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace one exact string in a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write a complete file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the repository.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description: "Finish the task and summarise what changed.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
        required: ["summary"],
        additionalProperties: false,
      },
    },
  },
];

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  input: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readPath(input: Record<string, unknown>): string | undefined {
  return stringField(input, ["file_path", "filePath", "path"]);
}

function canonicalError(): null {
  // A known tool family with unusable arguments is not replayable.
  return null;
}

function editFields(input: Record<string, unknown>): {
  oldString?: string;
  newString?: string;
} {
  let oldString = stringField(input, ["old_string", "oldString"]);
  let newString = stringField(input, ["new_string", "newString"]);

  // MultiEdit carries a list; canonical edit_file handles the first hunk.
  if (oldString === undefined && Array.isArray(input.edits)) {
    const first = recordOf(input.edits[0]);
    if (first !== undefined) {
      oldString = stringField(first, ["old_string", "oldString"]);
      newString = stringField(first, ["new_string", "newString"]);
    }
  }

  return { oldString, newString };
}

/**
 * Map a recorded tool call to the canonical replay tool.
 * Returns null for anything we cannot faithfully replay.
 */
export function toCanonicalAction(tool: ToolCall): CanonicalAction | null {
  const name = tool.name.trim().toLowerCase();
  const input = recordOf(tool.input) ?? {};

  switch (name) {
    case "read":
    case "view": {
      const path = readPath(input);
      return path === undefined ? canonicalError() : { tool: "read_file", args: { path } };
    }

    case "grep":
    case "glob":
    case "find": {
      const pattern = stringField(input, ["pattern", "query"]);
      if (pattern === undefined) return canonicalError();
      const path = readPath(input);
      return {
        tool: "search",
        args: path === undefined ? { pattern } : { pattern, path },
      };
    }

    case "ls":
    case "list": {
      const path = readPath(input) ?? ".";
      return { tool: "list_files", args: { path } };
    }

    case "edit":
    case "multiedit":
    case "patch": {
      const path = readPath(input);
      const { oldString, newString } = editFields(input);
      if (
        path === undefined ||
        oldString === undefined ||
        newString === undefined
      ) {
        return canonicalError();
      }
      return {
        tool: "edit_file",
        args: { path, old_string: oldString, new_string: newString },
      };
    }

    case "write": {
      const path = readPath(input);
      const content = stringField(input, ["content", "text"]);
      if (path === undefined || content === undefined) return canonicalError();
      return { tool: "write_file", args: { path, content } };
    }

    case "bash":
    case "execute": {
      const command = stringField(input, ["command"]);
      return command === undefined
        ? canonicalError()
        : { tool: "run_command", args: { command } };
    }

    default:
      return null;
  }
}

/** The first canonical action in a step, used as the replay baseline. */
export function stepCanonicalAction(toolCalls: ToolCall[]): CanonicalAction | null {
  for (const tool of toolCalls) {
    const action = toCanonicalAction(tool);
    if (action !== null) return action;
  }
  return null;
}