import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildHtmlReport,
  escapeHtml,
  writeHtmlReport,
} from "../src/report/html.js";
import type { Session, Step } from "../src/types.js";

function step(
  index: number,
  kind: Step["kind"],
  tool: { name: string; input: unknown },
  costUsd: number,
  inputTokens: number,
): Step {
  return {
    id: `step-${index}`,
    index,
    sessionId: "session-html",
    source: "claude-code",
    model: 'claude-sonnet-4-5" onload="alert(1)',
    startedAt: index * 1000,
    tools: [{ id: `tool-${index}`, name: tool.name, input: tool.input }],
    tokens: {
      input: inputTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
    costUsd,
    kind,
    isSidechain: false,
  };
}

const session: Session = {
  id: "session-html",
  source: "claude-code",
  title: '<script>alert("x")</script>',
  path: "/tmp/ws/transcript.jsonl",
  cwd: "/tmp/ws",
  steps: [
    step(
      0,
      "read",
      { name: "Read", input: { file_path: "/tmp/ws/src/a.ts" } },
      0.000123,
      100,
    ),
    step(
      1,
      "edit",
      { name: "Edit", input: { file_path: "/tmp/ws/src/y.ts" } },
      0.00005,
      50,
    ),
  ],
};

const html = buildHtmlReport(session);

describe("buildHtmlReport", () => {
  it("is self-contained with no external assets", () => {
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain('id="icicle"');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
  });

  it("escapes every transcript-derived string", () => {
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(html).not.toContain('<script>alert("x")');
    expect(html).toContain("onload=&quot;alert(1)");
    expect(html).not.toContain('onload="alert(1)');
  });

  it("renders header cards and the by-kind table", () => {
    for (const label of [
      "Total cost",
      "Tokens",
      "Steps",
      "Model",
      "Read + search + test",
    ]) {
      expect(html).toContain(label);
    }

    expect(html).toContain("$0.000173");
    expect(html).toContain("150");
    expect(html).toContain("71.1% of spend");
    expect(html).toContain("<th>Kind</th>");
    expect(html).toContain("<td>read</td>");
    expect(html).toContain("<td>edit</td>");
  });

  it("renders four rows of blocks with relative step frames", () => {
    // session + 2 phases + 2 kinds + 2 steps
    expect(html.match(/class="blk"/g)).toHaveLength(7);
    expect(html).toContain("read src/a.ts");
    expect(html).toContain("edit src/y.ts");
    expect(html).not.toContain("/tmp/ws/src");
    expect(html).toContain(">session</text>");
    expect(html).toContain(">phase</text>");
    expect(html).toContain(">kind</text>");
    expect(html).toContain(">step</text>");
  });

  it("writes a report file", () => {
    const dir = mkdtempSync(join(tmpdir(), "downshift-report-"));
    try {
      const path = join(dir, "report.html");
      expect(writeHtmlReport(session, path)).toBe(path);
      expect(readFileSync(path, "utf8")).toBe(html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
});
