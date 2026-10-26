import type { ChatMessage, ChatTool } from "../providers/index.js";
import type { Session, Step } from "../types.js";
import {
  canonicalTools,
  stepCanonicalAction,
  type CanonicalAction,
} from "./tools.js";

const TOOL_OUTPUT_LIMIT = 1500;

/** Placeholder kept in place of an old tool result when trimming for budget. */
const DROPPED_TOOL_OUTPUT = "(tool output dropped to fit the context budget)";

/**
 * The original system prompt is not stored in transcripts, so replays use a
 * neutral equivalent. It deliberately says nothing task-specific.
 */
const SYSTEM_PROMPT =
  "You are a coding agent working inside a software repository. Use the provided tools to make progress. Read and search before editing, keep changes focused, and call finish when the task is complete.";

export type ReplayAction = CanonicalAction | { text: string };

export interface ReplayRequest {
  messages: ChatMessage[];
  tools: ChatTool[];
  /** The step's own canonical action, or its text for plan steps. */
  original: ReplayAction | null;
}

function truncateOutput(output: string | undefined): string {
  return (output ?? "(no output captured)").slice(0, TOOL_OUTPUT_LIMIT);
}

function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

/** One assistant turn plus the tool results it produced. */
function historyMessages(step: Step): ChatMessage[] {
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  const toolMessages: ChatMessage[] = [];

  for (const tool of step.tools) {
    const action = stepCanonicalAction([tool]);
    if (action === null) continue;

    toolCalls.push({
      id: tool.id,
      type: "function",
      function: {
        name: action.tool,
        arguments: JSON.stringify(action.args),
      },
    });
    toolMessages.push({
      role: "tool",
      tool_call_id: tool.id,
      content: truncateOutput(tool.output),
    });
  }

  const content = step.text !== undefined && step.text.trim() !== "" ? step.text : null;
  if (toolCalls.length === 0) {
    return content === null ? [] : [{ role: "assistant", content }];
  }

  const messages: ChatMessage[] = [
    { role: "assistant", content, tool_calls: toolCalls },
    ...toolMessages,
  ];
  return messages;
}

function originalAction(step: Step): ReplayAction | null {
  const isPlan = step.kind === "plan" || step.tools.length === 0;
  if (isPlan) return { text: step.text ?? "" };
  return stepCanonicalAction(step.tools);
}

/**
 * A chronological slice of the conversation. Tool turns are kept together
 * (assistant tool_calls plus their tool results) so any prefix stays valid for
 * the API; a user prompt is its own block so it can survive when old tool
 * output is discarded.
 */
interface ContextBlock {
  messages: ChatMessage[];
  kind: "user" | "assistant" | "tool-turn";
  /** The fallback first prompt and the most recent user prompt are never dropped. */
  protected: boolean;
}

/** Build the replay context, oldest first, from the steps before `stepIndex`. */
function historyBlocks(session: Session, stepIndex: number): ContextBlock[] {
  const blocks: ContextBlock[] = [];

  for (let index = 0; index < stepIndex; index += 1) {
    const prior = session.steps[index];
    if (prior === undefined || prior.isSidechain) continue;

    const userText = prior.userText?.trim();
    if (userText !== undefined && userText !== "") {
      blocks.push({
        messages: [{ role: "user", content: userText }],
        kind: "user",
        protected: false,
      });
    }

    const messages = historyMessages(prior);
    if (messages.length > 0) {
      blocks.push({
        messages,
        kind: messages.some((message) => message.role === "tool")
          ? "tool-turn"
          : "assistant",
        protected: false,
      });
    }
  }

  return blocks;
}

/**
 * Build the chat request for replaying one step.
 *
 * History is reconstructed from the preceding assistant steps in the session,
 * because transcripts store tool results but not a replay-ready conversation.
 * Every captured user prompt is included in order. The oldest turns are dropped
 * until the character/4 estimate fits the provider's context budget: old tool
 * output goes first, and the most recent user prompt always stays.
 */
export function buildReplayRequest(
  session: Session,
  stepIndex: number,
  maxContextTokens: number,
): ReplayRequest {
  const step = session.steps[stepIndex];
  if (step === undefined) {
    throw new Error(
      `Step index ${stepIndex} is out of range for session "${session.id}".`,
    );
  }
  if (step.isSidechain) {
    throw new Error(
      `Step ${stepIndex} is a sidechain step and cannot be replayed.`,
    );
  }

  const firstUserMessage =
    session.firstUserMessage ?? session.title ?? "(no user message captured)";

  const blocks = historyBlocks(session, stepIndex);
  // The prompt that produced this step is the most recent user turn even though
  // the step's own assistant output must stay out of the request.
  const targetUserText = step.userText?.trim();
  if (targetUserText !== undefined && targetUserText !== "") {
    blocks.push({
      messages: [{ role: "user", content: targetUserText }],
      kind: "user",
      protected: false,
    });
  }
  const hasUserTurn = blocks.some((block) => block.kind === "user");

  // Transcripts from before userText existed only expose the first prompt.
  if (!hasUserTurn) {
    blocks.unshift({
      messages: [{ role: "user", content: firstUserMessage }],
      kind: "user",
      protected: true,
    });
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.kind === "user") {
      // The most recent prompt is the actual instruction for this step.
      (blocks[index] as ContextBlock).protected = true;
      break;
    }
  }

  const system: ChatMessage = { role: "system", content: SYSTEM_PROMPT };
  const build = (): ChatMessage[] => [
    system,
    ...blocks.flatMap((block) => block.messages),
  ];

  let messages = build();
  while (estimateTokens(messages) > maxContextTokens) {
    // Prefer discarding old tool exchanges, then old assistant turns and older
    // user prompts, before touching anything protected.
    let victim = blocks.findIndex(
      (block) => !block.protected && block.kind === "tool-turn",
    );
    if (victim === -1) {
      victim = blocks.findIndex((block) => !block.protected);
    }
    if (victim === -1) break;

    blocks.splice(victim, 1);
    messages = build();
  }

  return {
    messages,
    tools: canonicalTools,
    original: originalAction(step),
  };
}
