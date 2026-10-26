import { Command } from "commander";

const program = new Command();

function placeholder(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .action(() => {
      console.log(`${name}: not implemented yet`);
    });
}

program
  .name("downshift")
  .description(
    "Find where your AI agent can downshift to an open model — and prove it.",
  )
  .version("0.1.0");

program.addCommand(placeholder("sessions", "List and inspect recorded agent sessions"));
program.addCommand(placeholder("analyze", "Analyze a session and suggest downshift candidates"));
program.addCommand(placeholder("replay", "Replay recorded steps against an open model"));
program.addCommand(placeholder("policy", "Manage routing policies for agent steps"));
program.addCommand(placeholder("bench", "Run the benchmark suite for open models"));

program.parse();