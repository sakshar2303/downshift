import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import {
  buildSpeedscope,
  stepFrameName,
  validateSpeedscope,
  type SpeedscopeFile,
} from "../src/flame/speedscope.js";
import type { Session, Step, StepKind, ToolCall } from "../src/types.js";

function tool(name: string, input: unknown = {}): ToolCall {
  return { id: `${name}-1`, name, input };
}

function step(
  index: number,
  kind: StepKind,
  tools: ToolCall[],
  costUsd?: number,
  tokens: Partial<Step["tokens"]> = {},
): Step {
  return {
    id: `step-${index}`,
    index,
    sessionId: "session-flame",
    source: "claude-code",
    model: "claude-sonnet-4-5",
    startedAt: index * 1000,
    tools,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      ...tokens,
    },
    costUsd,
    kind,
    isSidechain: false,
  };
}

function session(steps: Step[]): Session {
  return {
    id: "session-flame",
    source: "claude-code",
    title: "Flame test",
    path: "/tmp/flame.jsonl",
    steps,
  };
}

const pricedSession = session([
  step(
    0,
    "read",
    [tool("Read", { file_path: "src/a.ts" })],
    0.000123,
    { input: 100 },
  ),
  step(
    1,
    "search",
    [tool("Bash", { command: "grep -rn foo src" })],
    0.00005,
    { input: 50 },
  ),
  step(
    2,
    "edit",
    [tool("Write", { file_path: "src/y.ts" })],
    0.0001,
    { input: 200 },
  ),
  step(3, "test", [tool("Bash", { command: "npm test" })], 0.00002, {
    input: 20,
  }),
  step(4, "plan", [], 0, { input: 10 }),
]);

function frameNameAt(file: SpeedscopeFile, index: number): string | undefined {
  return file.shared.frames[index]?.name;
}

function frameIndex(file: SpeedscopeFile, name: string): number {
  return file.shared.frames.findIndex((frame) => frame.name === name);
}

describe("buildSpeedscope", () => {
  const file = buildSpeedscope(pricedSession);
  const profile = file.profiles[0];

  it("emits the speedscope header and exporter", () => {
    expect(file["$schema"]).toBe(
      "https://www.speedscope.app/file-format-schema.json",
    );
    expect(file.name).toBe("downshift: Flame test");
    expect(file.exporter).toBe(`downshift@${packageJson.version}`);
  });

  it("names nested session, phase, kind and step frames", () => {
    const names = file.shared.frames.map((frame) => frame.name);
    expect(names).toContain("Flame test");
    expect(names).toContain("explore");
    expect(names).toContain("implement");
    expect(names).toContain("verify");
    expect(names).toContain("read src/a.ts");
    expect(names).toContain('grep "foo"');
    expect(names).toContain("edit src/y.ts");
    expect(names).toContain("npm test");
    expect(names).toContain("plan");
  });

  it("uses cumulative cost in integer micro-dollars", () => {
    expect(profile?.startValue).toBe(0);
    expect(profile?.endValue).toBe(293);
    expect(profile?.name).toBe("Flame test");
    expect(profile?.unit).toBe("none");

    const readIndex = frameIndex(file, "read src/a.ts");
    const open = profile?.events.find(
      (event) => event.type === "O" && event.frame === readIndex,
    );
    const close = profile?.events.find(
      (event) => event.type === "C" && event.frame === readIndex,
    );
    expect(open?.at).toBe(0);
    expect(close?.at).toBe(123);

    const ats = profile?.events.map((event) => event.at) ?? [];
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    expect(profile?.events[0]?.type).toBe("O");
    expect(profile?.events.at(-1)?.type).toBe("C");
  });

  it("passes validation", () => {
    const result = validateSpeedscope(file);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("falls back to tokens and labels the profile when a step has no cost", () => {
    const unpriced = session([
      step(0, "read", [tool("Read", { file_path: "src/a.ts" })], undefined, {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 50,
        reasoning: 10,
      }),
    ]);

    const unpricedFile = buildSpeedscope(unpriced);
    expect(unpricedFile.profiles[0]?.name).toBe("Flame test (tokens)");
    expect(unpricedFile.profiles[0]?.endValue).toBe(210);
    expect(validateSpeedscope(unpricedFile).valid).toBe(true);
  });
});

describe("stepFrameName", () => {
  it("describes common bash reads, searches and tests", () => {
    expect(
      stepFrameName(step(0, "read", [tool("Bash", { command: "sed -n 1,80p f.ts" })])),
    ).toEqual({ name: "read f.ts", kind: "read" });
    expect(
      stepFrameName(
        step(0, "search", [tool("Bash", { command: "grep -rn foo src | head" })]),
      ),
    ).toEqual({ name: 'grep "foo"', kind: "search" });
    expect(
      stepFrameName(step(0, "test", [tool("Bash", { command: "cd /x && npm test" })])),
    ).toEqual({ name: "npm test", kind: "test" });
  });

  it("names edits from redirects and tool paths", () => {
    expect(
      stepFrameName(
        step(0, "edit", [tool("Bash", { command: "cat > f.ts <<EOF" })]),
      ).name,
    ).toBe("edit f.ts");
    expect(
      stepFrameName(step(0, "edit", [tool("Edit", { file_path: "src/y.ts" })]))
        .name,
    ).toBe("edit src/y.ts");
  });
});

describe("validateSpeedscope", () => {
  it("rejects an unbalanced event stream", () => {
    const broken = structuredClone(buildSpeedscope(pricedSession));
    broken.profiles[0]?.events.pop();

    const result = validateSpeedscope(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/never closed|does not match/);
  });

  it("rejects decreasing timestamps and bad frame indexes", () => {
    const broken = structuredClone(buildSpeedscope(pricedSession));
    const profile = broken.profiles[0];
    if (profile !== undefined && profile.events.length >= 2) {
      profile.events[0] = { type: "O", at: 10, frame: 0 };
      profile.events[1] = { type: "C", at: 5, frame: 999 };
    }

    const result = validateSpeedscope(broken);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/decreased/);
    expect(result.errors.join(" ")).toMatch(/out of range/);
  });
});