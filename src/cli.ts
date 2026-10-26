import { Command } from "commander";
import pc from "picocolors";
import { parseClaudeCodeTranscript } from "./ingest/claude-code.js";
import {
  discoverSessions,
  normalizeSource,
  resolveTarget,
} from "./ingest/discover.js";
import { loadOpencodeSession } from "./ingest/opencode.js";
import type { Session, Tokens } from "./types.js";

const program = new Command();

function placeholder(name: string, description: string): Command {
  return new Command(name).description(description).action(() => {
    console.log(`${name}: not implemented yet`);
  });
}

function formatTimestamp(ms: number): string {
  if (ms <= 0) return "-";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function renderTable(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1
            ? cell
            : cell.padEnd(widths[index] ?? cell.length),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function loadSession(target: string): Session {
  const resolved = resolveTarget(target);
  const session =
    resolved.source === "opencode"
      ? loadOpencodeSession(resolved.path, resolved.id)
      : parseClaudeCodeTranscript(resolved.path);

  if (session === undefined) {
    throw new Error(`Session "${resolved.id}" was not found in ${resolved.path}`);
  }
  return session;
}

function sumTokens(steps: Session["steps"]): Tokens {
  const totals: Tokens = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  for (const step of steps) {
    totals.input += step.tokens.input;
    totals.output += step.tokens.output;
    totals.cacheRead += step.tokens.cacheRead;
    totals.cacheWrite += step.tokens.cacheWrite;
    totals.reasoning += step.tokens.reasoning;
  }
  return totals;
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exit(1);
}

program
  .name("downshift")
  .description(
    "Find where your AI agent can downshift to an open model — and prove it.",
  )
  .version("0.1.0");

program
  .command("sessions")
  .description("List the newest recorded agent sessions")
  .option("-s, --source <source>", "only show claude-code, opencode, or alan sessions")
  .action((options: { source?: string }) => {
    try {
      let filter: ReturnType<typeof normalizeSource>;
      if (options.source !== undefined) {
        filter = normalizeSource(options.source);
        if (filter === undefined) {
          throw new Error(
            `Unknown source "${options.source}". Expected alan, opencode, or claude-code.`,
          );
        }
      }

      const sessions = discoverSessions(filter);
      if (sessions.length === 0) {
        console.log(
          options.source === undefined
            ? "No recorded sessions found."
            : `No recorded ${options.source} sessions found.`,
        );
        return;
      }

      const shown = sessions.slice(0, 15);
      const rows: string[][] = [
        ["ID", "SOURCE", "STEPS", "TOKENS", "UPDATED", "TITLE"],
        ...shown.map((session) => [
          session.id,
          session.source,
          formatCount(session.stepCount),
          formatCount(session.totalTokens),
          formatTimestamp(session.updatedAt),
          session.title,
        ]),
      ];
      console.log(renderTable(rows));
      console.log(
        pc.dim(
          `\nShowing ${shown.length} of ${sessions.length} sessions. Use \`downshift analyze <target>\` to inspect one.`,
        ),
      );
    } catch (error) {
      fail(error);
    }
  });

program
  .command("analyze")
  .description("Inspect a session and show where its tokens went")
  .argument("[target]", "a .jsonl transcript, an OpenCode session id, or latest", "latest")
  .action((target: string) => {
    try {
      const session = loadSession(target);
      const totals = sumTokens(session.steps);

      console.log(`${pc.bold("Session")}  ${session.title ?? "(untitled)"}`);
      console.log(`${pc.bold("Source")}   ${session.source}`);
      console.log(`${pc.bold("Path")}     ${session.path}`);
      console.log(`${pc.bold("Steps")}    ${formatCount(session.steps.length)}`);
      console.log(
        `${pc.bold("Tokens")}   input=${formatCount(totals.input)} output=${formatCount(totals.output)} cacheRead=${formatCount(totals.cacheRead)} cacheWrite=${formatCount(totals.cacheWrite)} reasoning=${formatCount(totals.reasoning)}`,
      );

      if (session.steps.length === 0) return;
      console.log(`\n${pc.bold("First 10 steps")}`);
      const rows: string[][] = [["INDEX", "MODEL", "TOOLS"]];
      for (const step of session.steps.slice(0, 10)) {
        rows.push([
          String(step.index),
          step.model || "-",
          step.tools.map((tool) => tool.name).join(", ") || "-",
        ]);
      }
      console.log(renderTable(rows));
    } catch (error) {
      fail(error);
    }
  });

program.addCommand(placeholder("replay", "Replay recorded steps against an open model"));
program.addCommand(placeholder("policy", "Manage routing policies for agent steps"));
program.addCommand(placeholder("bench", "Run the benchmark suite for open models"));

program.parse();