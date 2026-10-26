import type { ChatMessage, ChatTool } from "../providers/index.js";
import type { Session, Step } from "../types.js";
import {
  canonicalTools,
  stepCanonicalAction,
  type CanonicalAction,
} from "./tools.js";

const TOOL_OUTPUT_LIMIT = 1500;

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
 * Build the chat request for replaying one step.
 *
 * History is reconstructed from the preceding assistant steps in the session,
 * because transcripts store tool results but not a replay-ready conversation.
 * The oldest turns are dropped until the character/4 estimate fits the
 * provider's context budget; the system prompt and first user message stay.
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

  const base: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: firstUserMessage },
  ];

  const turns: ChatMessage[][] = [];
  for (let index = 0; index < stepIndex; index += 1) {
    const prior = session.steps[index];
    if (prior === undefined || prior.isSidechain) continue;
    const messages = historyMessages(prior);
    if (messages.length > 0) turns.push(messages);
  }

  let messages = [...base, ...turns.flat()];
  while (estimateTokens(messages) > maxContextTokens && turns.length > 0) {
    // Keep the most recent turns: an agent needs local context more than the
    // beginning of a long session.
    turns.shift();
    messages = [...base, ...turns.flat()];
  }

  return {
    messages,
    tools: canonicalTools,
    original: originalAction(step),
  };
}