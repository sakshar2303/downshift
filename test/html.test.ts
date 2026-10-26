import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addReportSections,
  buildGroupedBlocks,
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
    // Both layers: each has session + 2 phases + 2 kinds + 2 steps.
    expect(html.match(/class="blk"/g)).toHaveLength(14);
    expect(html).toContain('id="layer-timeline"');
    expect(html).toContain('id="layer-grouped"');
    expect(html).toContain("read src/a.ts");
    expect(html).toContain("edit src/y.ts");
    expect(html).not.toContain("/tmp/ws/src");
    expect(html).toContain(">session</text>");
    expect(html).toContain(">phase</text>");
    expect(html).toContain(">kind</text>");
    expect(html).toContain(">step</text>");
  });

  it("shows a legend with the exact chart colors", () => {
    for (const kind of [
      "read",
      "search",
      "web",
      "edit",
      "test",
      "shell",
      "plan",
      "delegate",
      "other",
    ]) {
      expect(html).toContain(`>${kind}</span>`);
    }

    for (const color of [
      "#2563eb",
      "#0891b2",
      "#7c3aed",
      "#d97706",
      "#16a34a",
      "#ea580c",
      "#a855f7",
      "#c084fc",
      "#64748b",
    ]) {
      expect(html).toContain(`background:${color}`);
    }
  });

  it("defaults to the grouped view and offers a timeline toggle", () => {
    expect(html).toContain('data-mode="timeline"');
    expect(html).toContain('data-mode="grouped" aria-pressed="true"');
    expect(html).toContain('id="layer-grouped">');
    expect(html).toContain('id="layer-timeline" style="display:none"');
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


describe("buildGroupedBlocks", () => {
  function groupedSession(): Session {
    return {
      id: "grouped",
      source: "claude-code",
      title: "Grouped",
      path: "/tmp/ws/transcript.jsonl",
      cwd: "/tmp/ws",
      steps: [
        step(
          0,
          "read",
          { name: "Read", input: { file_path: "/tmp/ws/src/a.ts" } },
          0.0001,
          100,
        ),
        step(
          1,
          "edit",
          { name: "Edit", input: { file_path: "/tmp/ws/src/x.ts" } },
          0.0002,
          200,
        ),
        step(
          2,
          "read",
          { name: "Read", input: { file_path: "/tmp/ws/src/a.ts" } },
          0.0003,
          300,
        ),
        step(
          3,
          "read",
          { name: "Read", input: { file_path: "/tmp/ws/src/b.ts" } },
          0.00005,
          50,
        ),
      ],
    };
  }

  it("merges same-named leaves under the same parent and sums cost", () => {
    const blocks = buildGroupedBlocks(groupedSession());
    const labels = blocks.map((block) => `${block.depth}:${block.label}`);

    // The second read of a.ts collapses into the first.
    expect(labels).toEqual([
      "0:Grouped",
      "1:explore",
      "2:read",
      "3:read src/a.ts",
      "3:read src/b.ts",
      "1:implement",
      "2:edit",
      "3:edit src/x.ts",
    ]);

    const readA = blocks.find(
      (block) => block.depth === 3 && block.label === "read src/a.ts",
    );
    expect(readA?.costUsd).toBeCloseTo(0.0004, 12);
    expect(readA?.tokens).toBe(400);
    expect((readA?.end ?? 0) - (readA?.start ?? 0)).toBe(400);
  });

  it("sorts phases, kinds and leaves widest first", () => {
    const blocks = buildGroupedBlocks(groupedSession());

    const phases = blocks.filter((block) => block.depth === 1);
    expect(phases.map((block) => block.label)).toEqual([
      "explore",
      "implement",
    ]);
    expect(phases[0]?.start).toBe(0);
    expect(phases[0]?.end).toBe(450);
    expect(phases[1]?.start).toBe(450);
    expect(phases[1]?.end).toBe(650);

    const readSteps = blocks.filter(
      (block) => block.depth === 3 && block.kind === "read",
    );
    expect(readSteps.map((block) => block.label)).toEqual([
      "read src/a.ts",
      "read src/b.ts",
    ]);
    expect(readSteps[0]?.start).toBe(0);
    expect(readSteps[0]?.end).toBe(400);
    expect(readSteps[1]?.start).toBe(400);
    expect(readSteps[1]?.end).toBe(450);
  });
});

describe("addReportSections", () => {
  it("adds sections and replaces a section with the same id", () => {
    const dir = mkdtempSync(join(tmpdir(), "downshift-html-"));
    try {
      const path = join(dir, "report.html");
      writeHtmlReport(session, path);

      expect(
        addReportSections(path, [
          { id: "replay-matrix", title: "Replay matrix", body: "<p>first</p>" },
        ]),
      ).toBe(true);

      let html = readFileSync(path, "utf8");
      expect(html).toContain("Replay matrix");
      expect(html).toContain("<p>first</p>");
      expect(html).toContain("<!-- downshift:extra-sections -->");

      addReportSections(path, [
        { id: "replay-matrix", title: "Replay matrix", body: "<p>second</p>" },
        {
          id: "projected-savings",
          title: "Projected savings",
          body: "<p>savings</p>",
        },
      ]);

      html = readFileSync(path, "utf8");
      expect(html).not.toContain("<p>first</p>");
      expect(html).toContain("<p>second</p>");
      expect(html).toContain("<p>savings</p>");
      expect(html.split('data-downshift-section="replay-matrix"')).toHaveLength(
        2,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes section titles and ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "downshift-html-"));
    try {
      const path = join(dir, "report.html");
      writeHtmlReport(session, path);
      addReportSections(path, [
        {
          id: 'x"><script>alert(1)</script>',
          title: "<b>unsafe</b>",
          body: "<p>body</p>",
        },
      ]);
      const html = readFileSync(path, "utf8");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when the report does not exist", () => {
    expect(
      addReportSections(join(tmpdir(), "downshift-missing-report.html"), [
        { id: "x", title: "X", body: "" },
      ]),
    ).toBe(false);
  });
});
