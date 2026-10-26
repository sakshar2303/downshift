import { describe, expect, it } from "vitest";
import { classifyStep, TEST_COMMAND_PATTERN } from "../src/classify/kinds.js";
import type { Step, ToolCall } from "../src/types.js";

function tool(name: string, input: unknown = {}): ToolCall {
  return { id: `${name}-1`, name, input };
}

function step(tools: ToolCall[]): Step {
  return {
    id: "step-1",
    index: 0,
    sessionId: "session-1",
    source: "claude-code",
    model: "claude-sonnet-4-5",
    startedAt: 0,
    tools,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    isSidechain: false,
  };
}

describe("classifyStep", () => {
  it("classifies single tools case-insensitively", () => {
    expect(classifyStep(step([tool("Read")]))).toBe("read");
    expect(classifyStep(step([tool("NotebookRead")]))).toBe("read");
    expect(classifyStep(step([tool("Grep")]))).toBe("search");
    expect(classifyStep(step([tool("Glob")]))).toBe("search");
    expect(classifyStep(step([tool("LS")]))).toBe("search");
    expect(classifyStep(step([tool("WebFetch")]))).toBe("web");
    expect(classifyStep(step([tool("web_search")]))).toBe("web");
    expect(classifyStep(step([tool("Edit")]))).toBe("edit");
    expect(classifyStep(step([tool("MultiEdit")]))).toBe("edit");
    expect(classifyStep(step([tool("Write")]))).toBe("edit");
    expect(classifyStep(step([tool("Patch")]))).toBe("edit");
    expect(classifyStep(step([tool("Task")]))).toBe("delegate");
    expect(classifyStep(step([tool("Bash", { command: "git status" })]))).toBe(
      "shell",
    );
    expect(classifyStep(step([tool("execute", { command: "ls" })]))).toBe(
      "shell",
    );
  });

  it("recognises test commands run through bash or execute", () => {
    for (const command of [
      "npx vitest run",
      "jest --watch",
      "pytest -q",
      "mocha test",
      "go test ./...",
      "cargo test",
      "npm test",
      "pnpm run test",
      "yarn test",
      "bun test",
      "tsc",
      "tsc --noEmit",
      "npx playwright test",
    ]) {
      expect(classifyStep(step([tool("Bash", { command })]))).toBe("test");
      expect(classifyStep(step([tool("execute", { command })]))).toBe("test");
    }
  });

  it("does not treat unrelated commands as tests", () => {
    for (const command of [
      "echo test",
      "npm install",
      "cat package.json",
      "tsconfig-check",
    ]) {
      expect(classifyStep(step([tool("Bash", { command })]))).toBe("shell");
    }
  });

  it("treats missing or non-string commands as shell", () => {
    expect(classifyStep(step([tool("Bash", {})]))).toBe("shell");
    expect(classifyStep(step([tool("Bash", { command: 42 })]))).toBe("shell");
  });

  it("picks the highest-priority kind when a step has several tools", () => {
    expect(classifyStep(step([tool("Read"), tool("Edit")]))).toBe("edit");
    expect(
      classifyStep(step([tool("Read"), tool("Bash", { command: "npm test" })])),
    ).toBe("test");
    expect(classifyStep(step([tool("Read"), tool("Bash", { command: "ls" })]))).toBe(
      "shell",
    );
    expect(classifyStep(step([tool("Read"), tool("Task")]))).toBe("delegate");
    expect(classifyStep(step([tool("Read"), tool("WebFetch")]))).toBe("web");
    expect(classifyStep(step([tool("Read"), tool("Grep")]))).toBe("search");
    expect(classifyStep(step([tool("Grep"), tool("Read")]))).toBe("search");
  });

  it("classifies planning steps", () => {
    expect(classifyStep(step([]))).toBe("plan");
    expect(classifyStep(step([tool("TodoWrite")]))).toBe("plan");
    expect(classifyStep(step([tool("ExitPlanMode")]))).toBe("plan");
  });

  it("falls back to other for unknown and MCP tools", () => {
    expect(classifyStep(step([tool("mcp__github__create_issue")]))).toBe(
      "other",
    );
    expect(classifyStep(step([tool("SomethingNew")]))).toBe("other");
    expect(
      classifyStep(step([tool("SomethingNew"), tool("Read")])),
    ).toBe("read");
  });

  it("exposes the test command pattern used for classification", () => {
    expect(TEST_COMMAND_PATTERN.test("cargo test")).toBe(true);
    expect(TEST_COMMAND_PATTERN.test("cargo build")).toBe(false);
  });
});
