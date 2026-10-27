/**
 * A bot thread as turns (spec 03 §11.3): the assistant messages between two
 * user messages are one turn. What the bot skin shows of a turn is exactly
 * the old `spokenItems`: text with content, notices (`notification`,
 * `feature_limit`) and sub-agent parts, plus `offer_session`'s and
 * `paid_feature`'s and `bot_help`'s cards and `suggest_tasks`' buttons. A turn with none of those and no deliverables
 * renders nothing; other tool calls never make it visible.
 *
 * `botThreadView` derives, once per messages array, what each message shows:
 * hidden or not, a gap stamp before it, the reaction badge on a user
 * message, and the turn's deliverables after its last shown message.
 */
import { BOT_HELP_TOOL } from "@abacus-ai/contract/bot-help";
import { SUGGEST_TASKS_TOOL } from "@abacus-ai/contract/bots/suggested-tasks";
import { PAID_FEATURE_TOOL } from "@abacus-ai/contract/toolsets";
import type { UIMessage } from "@tanstack/ai-client";

import { hiddenUserMessage, userMessageText } from "../user-message";
import { turnDeliverables, type TurnDeliverable } from "./deliverables";
import { gapStamp, messageTime } from "./gap-stamp";
import { isEmojiOnly, turnReaction } from "./reactions";

export interface Turn {
  /** Index of the user message that opened the turn (-1: none). */
  userIndex: number;
  /** Indices of the turn's assistant messages, in order. */
  assistantIndices: number[];
}

/** Group the thread into turns; system messages are skipped. */
export function turnsOf(messages: readonly UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  messages.forEach((message, index) => {
    if (message.role === "user") {
      current = { userIndex: index, assistantIndices: [] };
      turns.push(current);
      return;
    }
    if (message.role !== "assistant") return;
    if (current == null) {
      current = { userIndex: -1, assistantIndices: [] };
      turns.push(current);
    }
    current.assistantIndices.push(index);
  });
  return turns;
}

type Loose = Record<string, unknown>;

const kindOf = (part: object): string | null => {
  const abacus = (
    (part as { metadata?: unknown }).metadata as { abacus?: Loose } | undefined
  )?.abacus;
  return typeof abacus?.kind === "string" ? abacus.kind : null;
};

export type SpokenPart =
  | { kind: "text"; content: string }
  | { kind: "notice" }
  | { kind: "subagent" }
  | { kind: "session-offer" }
  | { kind: "paid-feature" }
  | { kind: "bot-help" }
  | { kind: "suggested-tasks" };

/** Prefixed with its MCP server's name (`agent-tools_offer_session`): matched by suffix. */
export const isSessionOfferTool = (name: string): boolean =>
  name === "offer_session" || name.endsWith("_offer_session");

/** `paid_feature`, under its MCP server's prefix or bare. */
export const isPaidFeatureTool = (name: string): boolean =>
  name === PAID_FEATURE_TOOL || name.endsWith(`_${PAID_FEATURE_TOOL}`);

/** `bot_help`, under its MCP server's prefix or bare. */
export const isBotHelpTool = (name: string): boolean =>
  name === BOT_HELP_TOOL || name.endsWith(`_${BOT_HELP_TOOL}`);

/** `suggest_tasks`, under its MCP server's prefix or bare. */
export const isSuggestTasksTool = (name: string): boolean =>
  name === SUGGEST_TASKS_TOOL || name.endsWith(`_${SUGGEST_TASKS_TOOL}`);

const indexes = new WeakMap<readonly UIMessage[], Map<string, number>>();

/**
 * Where `id` sits in `messages` (-1 when absent). The id map is built once per
 * array, so every row asking per stream tick costs O(1), not a rescan.
 */
export function messageIndexOf(
  messages: readonly UIMessage[],
  id: string
): number {
  let map = indexes.get(messages);
  if (map == null) {
    map = new Map();
    messages.forEach((message, index) => {
      if (!map!.has(message.id)) map!.set(message.id, index);
    });
    indexes.set(messages, map);
  }
  return map.get(id) ?? -1;
}

/** The parts of an assistant message the bot skin shows (`spokenItems`). */
export function spokenParts(message: UIMessage): SpokenPart[] {
  const out: SpokenPart[] = [];
  for (const part of message.parts) {
    if (part.type === "subagent") {
      out.push({ kind: "subagent" });
      continue;
    }
    // Its card is part of the reply: the bot's text points at its button.
    if (part.type === "tool-call" && isSessionOfferTool(part.name)) {
      out.push({ kind: "session-offer" });
      continue;
    }
    // The upgrade the reply points at.
    if (part.type === "tool-call" && isPaidFeatureTool(part.name)) {
      out.push({ kind: "paid-feature" });
      continue;
    }
    // The place in the app the reply names.
    if (part.type === "tool-call" && isBotHelpTool(part.name)) {
      out.push({ kind: "bot-help" });
      continue;
    }
    // The tasks the reply ends with, tapped instead of typed.
    if (part.type === "tool-call" && isSuggestTasksTool(part.name)) {
      out.push({ kind: "suggested-tasks" });
      continue;
    }
    if (part.type !== "text") continue;
    const kind = kindOf(part);
    const content = (part as { content: string }).content;
    if (kind === null) {
      if (content.trim().length > 0) out.push({ kind: "text", content });
    } else if (kind === "notification" || kind === "feature_limit")
      out.push({ kind: "notice" });
  }
  return out;
}

/** A turn that said nothing and made nothing. */
export function turnIsSilent(
  assistantMessages: readonly UIMessage[],
  deliverables: readonly TurnDeliverable[] = turnDeliverables(assistantMessages)
): boolean {
  return (
    deliverables.length === 0 &&
    assistantMessages.every((message) => spokenParts(message).length === 0)
  );
}

export interface BotMessageView {
  hidden: boolean;
  /** A 15-minute gap stamp goes before this message (its time). */
  stampBefore: Date | null;
  /** User messages: the bot's reaction badge. */
  reaction: string | null;
  /** Deliverables rendered after this message (the turn's last shown one). */
  deliverables: TurnDeliverable[] | null;
  /** The message belongs to the live turn (no feedback there). */
  live: boolean;
  /** An assistant message that said something (feedback applies). */
  spoke: boolean;
}

const HIDDEN: BotMessageView = {
  hidden: true,
  stampBefore: null,
  reaction: null,
  deliverables: null,
  live: false,
  spoke: false,
};

/** Every message's view; `runActive` holds a trailing emoji of the live turn. */
export function botThreadView(
  messages: readonly UIMessage[],
  runActive: boolean
): BotMessageView[] {
  const views: BotMessageView[] = messages.map((message) => ({
    ...HIDDEN,
    hidden: message.role !== "user" || hiddenUserMessage(message),
  }));
  const turns = turnsOf(messages);
  turns.forEach((turn, turnIndex) => {
    const assistants = turn.assistantIndices.map((i) => messages[i]!);
    const reaction = turnReaction(assistants);
    const live = runActive && turnIndex === turns.length - 1;
    if (turn.userIndex >= 0) views[turn.userIndex]!.reaction = reaction;
    const deliverables = turnDeliverables(assistants);
    let lastShown = -1;
    turn.assistantIndices.forEach((index, position) => {
      const spoken = spokenParts(
        botVisibleMessage(messages[index]!, messages, runActive)
      );
      const texts = spoken.filter((part) => part.kind === "text");
      const emojiOnly =
        texts.length > 0 &&
        texts.length === spoken.length &&
        texts.every((part) => isEmojiOnly(part.content));
      // An emoji reply repeating the reaction is dropped; a trailing emoji
      // of the live turn is held until it is known whether it is a reaction.
      const suppressed =
        emojiOnly &&
        ((reaction != null &&
          texts.every((part) => part.content.trim() === reaction)) ||
          (live &&
            position === turn.assistantIndices.length - 1 &&
            index === messages.length - 1));
      const shown = spoken.length > 0 && !suppressed;
      views[index] = {
        ...HIDDEN,
        hidden: !shown,
        live,
        spoke: shown && texts.length > 0,
      };
      if (shown) lastShown = index;
    });
    if (deliverables.length > 0) {
      const carrier =
        lastShown >= 0 ? lastShown : turn.assistantIndices.at(-1)!;
      views[carrier] = {
        ...views[carrier]!,
        hidden: false,
        deliverables,
      };
    }
  });
  let previous: Date | null = null;
  messages.forEach((message, index) => {
    const view = views[index]!;
    if (view.hidden) return;
    const at = messageTime(message);
    if (gapStamp(previous, at)) view.stampBefore = at;
    if (at != null) previous = at;
  });
  return views;
}

/** Keep spoken parts and tool pairs used by inline permission cards. */
export function botVisibleMessage(
  message: UIMessage,
  messages: readonly UIMessage[],
  runActive: boolean
): UIMessage {
  if (message.role === "user") {
    if (hiddenUserMessage(message))
      return message.parts.length === 0 ? message : { ...message, parts: [] };
    const raw = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.content)
      .join("");
    const content = userMessageText(message);
    if (content === raw) return message;
    const tags = message.metadata?.abacus?.userText as
      | import("@abacus-ai/contract/agent-types").UserTextTags
      | undefined;
    return {
      ...message,
      parts: [
        { type: "text", content },
        ...message.parts.filter((part) => part.type !== "text"),
      ],
      metadata: {
        ...message.metadata,
        abacus: {
          ...message.metadata?.abacus,
          ...(tags != null && {
            userText: {
              ...tags,
              ...(tags.visibleFrom != null && { visibleFrom: 0 }),
              ...(tags.operator != null && {
                operator: { ...tags.operator, visibleFrom: 0 },
              }),
            },
          }),
        },
      },
    };
  }
  if (message.role !== "assistant") return message;
  const index = messageIndexOf(messages, message.id);
  const turn = turnsOf(messages).find((row) =>
    row.assistantIndices.includes(index)
  );
  const reaction = turn
    ? turnReaction(turn.assistantIndices.map((i) => messages[i]!))
    : null;
  const trailing = runActive && index === messages.length - 1;
  const parts = message.parts.filter((part, partIndex) => {
    if (
      part.type === "tool-call" ||
      part.type === "tool-result" ||
      part.type === "subagent"
    )
      return true;
    if (part.type !== "text") return false;
    const kind = kindOf(part);
    if (kind === "notification" || kind === "feature_limit") return true;
    if (kind !== null || !part.content.trim()) return false;
    if (!isEmojiOnly(part.content)) return true;
    return (
      part.content.trim() !== reaction &&
      !(trailing && partIndex === message.parts.length - 1)
    );
  });
  return parts.length === message.parts.length
    ? message
    : { ...message, parts };
}
