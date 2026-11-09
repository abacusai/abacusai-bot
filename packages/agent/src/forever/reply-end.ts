/**
 * A tool that closes a reply ends the turn in code. Asked to write nothing
 * more, cheap models write the whole reply again, paying for a second request.
 * pi ends a run only when every call in the batch sets `terminate`, so a call
 * beside other tools leaves the turn running for the model to read their results.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { tidyBotText } from "../bot/bot-output.js";
import { splitReasoning } from "../reasoning-tags.js";

type PiAgent = AgentSession["agent"];
type AfterToolCallContext = Parameters<
  NonNullable<PiAgent["afterToolCall"]>
>[0];

/** The app's tools a reply ends with; the name is bare because the app's own server does not prefix. */
const REPLY_CLOSING_TOOLS: ReadonlySet<string> = new Set(["suggest_tasks"]);

/** Whether a tool closes the reply: a batch of only these may end the run. */
export const closesReply = (name: string): boolean =>
  REPLY_CLOSING_TOOLS.has(name);

type AssistantMessage = AfterToolCallContext["assistantMessage"];

/** Whether the message says anything the user sees: leaked reasoning is not a reply. */
export const hasWords = (message: AssistantMessage): boolean => {
  const raw = message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  const split = splitReasoning(raw);
  // An unclosed leading block is reasoning that lost its close, not a reply.
  return !split.reclaimed && tidyBotText(split.text).trim().length > 0;
};

const ranOtherTool = (message: AssistantMessage): boolean =>
  message.content.some(
    (block) => block.type === "toolCall" && !REPLY_CLOSING_TOOLS.has(block.name)
  );

/**
 * Whether the reply this call closes is written: in its own message, or in one
 * before it that only tried this tool (a refused call retried). Words ahead of
 * another tool are narration: the reply to that tool's result is still owed.
 */
const replyWritten = ({
  assistantMessage,
  context,
}: AfterToolCallContext): boolean => {
  for (const message of context.messages.toReversed()) {
    if (message.role === "user") return false;
    if (message.role !== "assistant") continue;
    if (message !== assistantMessage && ranOtherTool(message)) return false;
    if (hasWords(message)) return true;
  }
  return false;
};

/**
 * Sets `terminate` on a closing tool's accepted call once the reply is written.
 * A call ahead of the reply leaves the turn running, so the user still gets
 * one. Wraps pi's hook because its `tool_result` event cannot set `terminate`.
 */
export function endTurnOnClosedReply(agent: PiAgent): void {
  const afterToolCall = agent.afterToolCall;
  agent.afterToolCall = async (context, signal) => {
    const after = await afterToolCall?.(context, signal);
    // An MCP tool's refusal is a returned flag: pi's `isError` is only a throw.
    const { isError } = context.result as { isError?: boolean };
    if (
      context.isError ||
      isError === true ||
      after?.isError === true ||
      !REPLY_CLOSING_TOOLS.has(context.toolCall.name) ||
      !replyWritten(context)
    )
      return after;
    return { ...after, terminate: true };
  };
}
