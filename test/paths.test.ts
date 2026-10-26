import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { displayPath } from "../src/paths.js";

describe("displayPath", () => {
  const cwd = join("/Users", "alice", "projects", "downshift");

  it("makes paths inside the session cwd relative", () => {
    expect(displayPath(join(cwd, "src", "cli.ts"), cwd)).toBe("src/cli.ts");
    expect(displayPath(join(cwd, "src", "ingest", "opencode.ts"), cwd)).toBe(
      "src/ingest/opencode.ts",
    );
    expect(displayPath(cwd, cwd)).toBe(".");
  });

  it("does not treat a sibling with the same prefix as inside the cwd", () => {
    const sibling = join("/Users", "alice", "projects", "downshift-other", "x.ts");
    expect(displayPath(sibling, cwd)).not.toBe("x.ts");
    expect(displayPath(sibling, cwd)).not.toContain("~/");
  });

  it("shortens other home-directory paths to ~/...", () => {
    const home = homedir();
    expect(displayPath(join(home, ".claude", "projects", "a.jsonl"), cwd)).toBe(
      "~/.claude/projects/a.jsonl",
    );
    expect(displayPath(home, cwd)).toBe("~");
  });

  it("leaves paths outside the cwd and home untouched", () => {
    expect(displayPath("/tmp/downshift/a.ts", cwd)).toBe("/tmp/downshift/a.ts");
  });

  it("leaves relative paths alone", () => {
    expect(displayPath("src/a.ts", cwd)).toBe("src/a.ts");
    expect(displayPath("./src/a.ts", cwd)).toBe("./src/a.ts");
  });
});