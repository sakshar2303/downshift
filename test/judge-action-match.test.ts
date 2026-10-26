import { describe, expect, it } from "vitest";
import {
  MATCH_THRESHOLD,
  isMatch,
  jaccard,
  levenshtein,
  normalizePath,
  normalizedLevenshtein,
  score,
  tokenize,
} from "../src/judge/action-match.js";
import type { CanonicalAction, CanonicalToolName } from "../src/replay/tools.js";

const CWD = "/repo/project";

function action(
  tool: CanonicalToolName,
  args: Record<string, unknown>,
): CanonicalAction {
  return { tool, args };
}

describe("path and token helpers", () => {
  it("strips ./ and resolves relative paths against the cwd", () => {
    expect(normalizePath("./src/a.ts", CWD)).toBe("/repo/project/src/a.ts");
    expect(normalizePath("src/a.ts", CWD)).toBe("/repo/project/src/a.ts");
    expect(normalizePath("src/../src/a.ts", CWD)).toBe(
      "/repo/project/src/a.ts",
    );
  });

  it("keeps absolute paths absolute and collapses trailing slashes", () => {
    expect(normalizePath("/other/b.ts", CWD)).toBe("/other/b.ts");
    expect(normalizePath("/other/dir/", CWD)).toBe("/other/dir");
  });

  it("normalizes Windows separators", () => {
    expect(normalizePath(".\\src\\a.ts", CWD)).toBe("/repo/project/src/a.ts");
  });

  it("treats an empty path as the cwd", () => {
    expect(normalizePath("./", CWD)).toBe("/repo/project");
  });

  it("tokenizes on non-word characters and lowercases", () => {
    expect(tokenize("Foo-Bar_baz.qux")).toEqual(["foo", "bar_baz", "qux"]);
    expect(tokenize("  ")).toEqual([]);
  });

  it("computes Jaccard over sets, including empty sets", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
    expect(jaccard(["a", "a", "b"], ["b", "a"])).toBe(1);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a"], [])).toBe(0);
  });

  it("computes Levenshtein distance and normalized similarity", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
    expect(normalizedLevenshtein("same", "same")).toBe(1);
    expect(normalizedLevenshtein("abc", "abd")).toBeCloseTo(2 / 3, 10);
    expect(normalizedLevenshtein("", "")).toBe(1);
    expect(normalizedLevenshtein("abcd", "wxyz")).toBe(0);
  });
});

describe("different tools", () => {
  it("scores unrelated tools at zero", () => {
    expect(
      score(
        action("read_file", { path: "src/a.ts" }),
        action("run_command", { command: "npm test" }),
        CWD,
      ),
    ).toBe(0);
    expect(
      score(
        action("edit_file", { path: "src/a.ts", new_string: "x" }),
        action("write_file", { path: "src/a.ts", content: "x" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("gives search vs list_files a weak 0.3 in either direction", () => {
    const search = action("search", { pattern: "foo", path: "src" });
    const list = action("list_files", { path: "src" });
    expect(score(search, list, CWD)).toBe(0.3);
    expect(score(list, search, CWD)).toBe(0.3);
  });

  it("does not reward an unrelated weak match", () => {
    expect(
      score(
        action("search", { pattern: "foo" }),
        action("read_file", { path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("scores finish only against finish", () => {
    expect(score(action("finish", {}), action("finish", {}), CWD)).toBe(1);
    expect(
      score(action("finish", {}), action("read_file", { path: "a" }), CWD),
    ).toBe(0);
  });
});

describe("missing tool calls", () => {
  const original = action("read_file", { path: "src/a.ts" });

  it("scores no replay call at zero", () => {
    expect(score(null, original, CWD)).toBe(0);
  });

  it("scores replay text at zero when the original called a tool", () => {
    expect(score({ text: "I would read src/a.ts" }, original, CWD)).toBe(0);
  });

  it("scores plan text originals at zero (the LLM judge handles them)", () => {
    expect(score(original, { text: "Read src/a.ts next" }, CWD)).toBe(0);
    expect(score({ text: "a" }, { text: "a" }, CWD)).toBe(0);
  });

  it("scores two nulls at zero", () => {
    expect(score(null, null, CWD)).toBe(0);
  });
});

describe("read_file", () => {
  it("scores the same normalized path at one", () => {
    expect(
      score(
        action("read_file", { path: "./src/a.ts" }),
        action("read_file", { path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("resolves both sides against the cwd", () => {
    expect(
      score(
        action("read_file", { path: `${CWD}/src/a.ts` }),
        action("read_file", { path: "./src/a.ts" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores a sibling file in the same directory at 0.5", () => {
    expect(
      score(
        action("read_file", { path: "src/b.ts" }),
        action("read_file", { path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(0.5);
  });

  it("scores a different directory at zero", () => {
    expect(
      score(
        action("read_file", { path: "test/a.ts" }),
        action("read_file", { path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("scores missing paths at zero", () => {
    expect(
      score(action("read_file", {}), action("read_file", { path: "a" }), CWD),
    ).toBe(0);
  });

  it("accepts file_path as an alias", () => {
    expect(
      score(
        action("read_file", { file_path: "src/a.ts" }),
        action("read_file", { file_path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(1);
  });
});

describe("search", () => {
  it("scores identical patterns and scope at one", () => {
    expect(
      score(
        action("search", { pattern: "TODO", path: "src" }),
        action("search", { pattern: "todo", path: "./src/" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scales token Jaccard to 0.8 without a scope bonus", () => {
    // {foo, bar} vs {foo, baz}: 1/3 overlap.
    const value = score(
      action("search", { pattern: "foo baz", path: "test" }),
      action("search", { pattern: "foo bar", path: "src" }),
      CWD,
    );
    expect(value).toBeCloseTo(0.8 / 3, 10);
  });

  it("adds 0.2 for a matching path scope", () => {
    const value = score(
      action("search", { pattern: "foo baz", path: "src" }),
      action("search", { pattern: "foo bar", path: "src" }),
      CWD,
    );
    expect(value).toBeCloseTo(0.8 / 3 + 0.2, 10);
  });

  it("treats a missing scope as the cwd on both sides", () => {
    expect(
      score(
        action("search", { pattern: "alpha beta" }),
        action("search", { pattern: "alpha beta" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("does not award the scope bonus when only one side has a scope", () => {
    expect(
      score(
        action("search", { pattern: "alpha" }),
        action("search", { pattern: "alpha", path: "src" }),
        CWD,
      ),
    ).toBeCloseTo(0.8, 10);
  });

  it("scores disjoint patterns at zero without a scope match", () => {
    expect(
      score(
        action("search", { pattern: "zzz", path: "test" }),
        action("search", { pattern: "aaa", path: "src" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("accepts query as a pattern alias and counters empty tokens", () => {
    expect(
      score(
        action("search", { query: "foo" }),
        action("search", { pattern: "foo" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores missing patterns at zero", () => {
    expect(score(action("search", {}), action("search", { pattern: "a" }), CWD)).toBe(0);
  });
});

describe("list_files", () => {
  it("scores the same directory at one and another at zero", () => {
    expect(
      score(
        action("list_files", { path: "./src/" }),
        action("list_files", { path: "src" }),
        CWD,
      ),
    ).toBe(1);
    expect(
      score(
        action("list_files", { path: "src" }),
        action("list_files", { path: "test" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("scores missing paths at zero", () => {
    expect(score(action("list_files", {}), action("list_files", { path: "src" }), CWD)).toBe(0);
  });
});

describe("run_command", () => {
  it("scores identical commands after collapsing whitespace at one", () => {
    expect(
      score(
        action("run_command", { command: "npm   test" }),
        action("run_command", { command: " npm test " }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores the same executable with overlapping args at 0.5 + Jaccard", () => {
    expect(
      score(
        action("run_command", { command: "npm run test" }),
        action("run_command", { command: "npm test" }),
        CWD,
      ),
    ).toBeCloseTo(0.75, 10);
  });

  it("scores identical arguments under the same executable at one", () => {
    expect(
      score(
        action("run_command", { command: "node  -e  x" }),
        action("run_command", { command: "node -e x" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores the same executable with disjoint arguments at 0.5", () => {
    expect(
      score(
        action("run_command", { command: "npm run build" }),
        action("run_command", { command: "npm test" }),
        CWD,
      ),
    ).toBe(0.5);
  });

  it("ignores the path to the executable", () => {
    expect(
      score(
        action("run_command", { command: "/usr/local/bin/npm test" }),
        action("run_command", { command: "npm test" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores different executables at zero", () => {
    expect(
      score(
        action("run_command", { command: "pnpm test" }),
        action("run_command", { command: "npm test" }),
        CWD,
      ),
    ).toBe(0);
  });

  it("scores missing commands at zero", () => {
    expect(score(action("run_command", {}), action("run_command", { command: "ls" }), CWD)).toBe(0);
  });
});

describe("edit_file and write_file", () => {
  it("scores an identical same-path edit at one", () => {
    expect(
      score(
        action("edit_file", { path: "./src/a.ts", new_string: "const a = 1" }),
        action("edit_file", { path: "src/a.ts", new_string: "const a = 1" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores an identical same-path write at one", () => {
    expect(
      score(
        action("write_file", { path: "src/b.ts", content: "hello" }),
        action("write_file", { path: "src/b.ts", content: "hello" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("gives 0.5 for the path plus 0.5 x text similarity", () => {
    // "abc" vs "abd" -> 2/3 similarity.
    expect(
      score(
        action("edit_file", { path: "src/a.ts", new_string: "abd" }),
        action("edit_file", { path: "src/a.ts", new_string: "abc" }),
        CWD,
      ),
    ).toBeCloseTo(0.5 + 0.5 * (2 / 3), 10);
  });

  it("drops the path half when the path differs", () => {
    expect(
      score(
        action("write_file", { path: "src/other.ts", content: "same" }),
        action("write_file", { path: "src/a.ts", content: "same" }),
        CWD,
      ),
    ).toBe(0.5);
  });

  it("scores same-path totally different text at 0.5", () => {
    expect(
      score(
        action("edit_file", { path: "src/a.ts", new_string: "zzzz" }),
        action("edit_file", { path: "src/a.ts", new_string: "aaaa" }),
        CWD,
      ),
    ).toBeCloseTo(0.5, 10);
  });

  it("caps both texts at 4000 chars before comparing", () => {
    const prefix = "x".repeat(4_000);
    expect(
      score(
        action("write_file", { path: "src/a.ts", content: `${prefix}B` }),
        action("write_file", { path: "src/a.ts", content: `${prefix}A` }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores missing text as an empty string", () => {
    expect(
      score(
        action("write_file", { path: "src/a.ts", content: "" }),
        action("write_file", { path: "src/a.ts" }),
        CWD,
      ),
    ).toBe(1);
  });

  it("scores missing paths at zero", () => {
    expect(
      score(
        action("write_file", { content: "x" }),
        action("write_file", { path: "src/a.ts", content: "x" }),
        CWD,
      ),
    ).toBe(0);
  });
});

describe("match threshold", () => {
  it("matches at exactly 0.8 and above", () => {
    expect(MATCH_THRESHOLD).toBe(0.8);
    expect(isMatch(0.8)).toBe(true);
    expect(isMatch(1)).toBe(true);
    expect(isMatch(0.799)).toBe(false);
  });

  it("never returns a score outside [0, 1]", () => {
    const cases: Array<[CanonicalAction, CanonicalAction]> = [
      [
        action("search", { pattern: "a b c", path: "src" }),
        action("search", { pattern: "a b c", path: "src" }),
      ],
      [
        action("run_command", { command: "npm test" }),
        action("run_command", { command: "npm test" }),
      ],
    ];
    for (const [left, right] of cases) {
      const value = score(left, right, CWD);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});