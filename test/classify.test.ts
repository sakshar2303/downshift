import { describe, expect, it } from "vitest";
import {
  classifyShellCommand,
  classifyStep,
  splitCommandSegments,
  summarizeShellCalls,
  TEST_COMMAND_PATTERN,
} from "../src/classify/kinds.js";
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
      "search",
    );
    expect(classifyStep(step([tool("execute", { command: "ls" })]))).toBe(
      "search",
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
    for (const command of ["echo test", "npm install", "tsconfig-check"]) {
      expect(classifyStep(step([tool("Bash", { command })]))).toBe("shell");
    }
    expect(classifyStep(step([tool("Bash", { command: "cat package.json" })]))).toBe(
      "read",
    );
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
      "search",
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

  it("classifies reads and searches hidden inside bash commands", () => {
    const cases: Array<[string, string]> = [
      ["cd /x && cat src/a.ts", "read"],
      ["grep -rn foo src | head -20", "search"],
      ["git status && git log --oneline -5", "search"],
      ["sed -n 1,80p f.ts", "read"],
      ["sed -i 's/a/b/' f", "shell"],
      ["npm run -s typecheck", "test"],
      ["git add -A && git commit -m x && git push", "shell"],
      ["cat > f.ts <<EOF", "shell"],
      ["FOO=bar cat package.json", "read"],
      ["ls -la", "search"],
      ["rg TODO src", "search"],
      ["find . -name '*.ts'", "search"],
      ["npm run lint", "test"],
      ["npx tsc --noEmit", "test"],
      ["npx vitest run", "test"],
      ["npm test 2>&1", "test"],
      ["rm -rf dist", "shell"],
      ["curl https://example.com", "shell"],
      ["git diff HEAD~1", "search"],
      ["grep -rn vitest src", "search"],
      ["cat jest.config.ts", "read"],
      ["make 2> build.log", "shell"],
    ];

    for (const [command, expected] of cases) {
      expect(classifyShellCommand(command)).toBe(expected);
      expect(classifyStep(step([tool("Bash", { command })]))).toBe(expected);
    }
  });

  it("does not split on separators inside quotes", () => {
    expect(splitCommandSegments('echo "a | b" && cat f')).toEqual([
      'echo "a | b"',
      "cat f",
    ]);
    expect(classifyShellCommand('grep "a|b" f && cat g')).toBe("search");
  });

  it("treats only all-plan tool sets as plan steps", () => {
    expect(classifyStep(step([tool("TodoWrite"), tool("Edit")]))).toBe("edit");
    expect(classifyStep(step([tool("ExitPlanMode"), tool("TodoWrite")]))).toBe(
      "plan",
    );
  });

  it("summarizes bash calls that were really reads, searches or tests", () => {
    const steps = [
      step([tool("Bash", { command: "cat package.json" })]),
      step([tool("Bash", { command: "grep -rn foo src" })]),
      step([tool("Bash", { command: "npm test" })]),
      step([tool("Bash", { command: "git push" })]),
      step([tool("Edit")]),
    ];
    expect(summarizeShellCalls(steps)).toEqual({ total: 4, informative: 3 });
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
