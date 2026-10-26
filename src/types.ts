export type StepKind =
  | "read"
  | "search"
  | "web"
  | "edit"
  | "test"
  | "shell"
  | "plan"
  | "delegate"
  | "other";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: string;
}

export interface Step {
  id: string;
  index: number;
  sessionId: string;
  source: "claude-code" | "opencode";
  model: string;
  provider?: string;
  startedAt: number;
  tools: ToolCall[];
  text?: string;
  /** Human text that prompted this assistant turn. */
  userText?: string;
  tokens: Tokens;
  recordedCostUsd?: number;
  isSidechain: boolean;
  kind?: StepKind;
  costUsd?: number;
}

export interface Session {
  id: string;
  source: Step["source"];
  title?: string;
  /** First real user prompt, kept for replay context (titles are truncated). */
  firstUserMessage?: string;
  path: string;
  cwd?: string;
  steps: Step[];
}