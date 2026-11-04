/**
 * Channels: the user and several of their bots in one thread, around a
 * name and what the channel is about. The app decides who speaks (never the bots), so a message gets one
 * answer unless the user asks for more; a bot brings in another member by
 * @mentioning it, one level deep. See apps/desktop/src/main/services/channels.
 */

export const MIN_CHANNEL_MEMBERS = 2;
export const MAX_CHANNEL_MEMBERS = 6;

/** A line the user pinned: every bot sees it on every turn, verbatim. */
export interface ChannelDecision {
  id: string;
  text: string;
  /** The message it was pinned from, when it was. */
  messageId?: string;
  at: number;
}

export interface Channel {
  id: string;
  /** Empty: shown as the members' names. */
  name: string;
  /** What the channel is for, in the user's words: every bot is told. */
  about?: string;
  /** Bot ids in the order they were added; the first is the lead. */
  memberBotIds: string[];
  decisions: ChannelDecision[];
  createdAt: number;
  updatedAt: number;
}

export type ChannelAuthor = { kind: "user" } | { kind: "bot"; botId: string };

export interface ChannelMessage {
  id: string;
  author: ChannelAuthor;
  text: string;
  at: number;
  /** The user's message this one answers, for a bot's message. */
  replyTo?: string;
  /** A bot that could not answer: `text` says why. */
  failed?: boolean;
  /**
   * Real work the bot took to its own chat (files, code, browser, accounts):
   * its status, and the bot's report once done, posted as its own message.
   */
  work?: ChannelWork;
  /** The lead's summing-up of a team discussion: offered for pinning. */
  conclusion?: boolean;
  /** The user started its agreed items as work. */
  planStarted?: boolean;
  /** A bot proposed to the user: a new one, or one of theirs to invite. */
  proposal?: ChannelBotProposal;
}

export interface ChannelBotProposal {
  name: string;
  title: string;
  /** What it would do: becomes its mission. */
  mission: string;
  status: "proposed" | "created" | "dismissed";
  /** An existing bot to add (an invite); else the bot made from it, once created. */
  botId?: string;
  /** An existing bot of the user's, not in the channel: Add puts it in. */
  invite?: boolean;
}

export type ChannelWorkStatus = "running" | "done" | "failed" | "stopped";

export interface ChannelWork {
  /** What the bot said it would do, complete on its own. */
  task: string;
  status: ChannelWorkStatus;
  /** Why it failed or stopped. */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** A channel as the sidebar lists it. */
export interface ChannelSummary extends Channel {
  /** Bots answering right now. */
  working: string[];
  /** Messages still waiting for their turn. */
  queued: number;
  last?: Pick<ChannelMessage, "author" | "text" | "at">;
}

export interface ChannelThread {
  channel: ChannelSummary;
  messages: ChannelMessage[];
}

export type ChannelsEvent = { type: "changed"; channelId: string | null };

/** The name a channel shows: its own, else its members' names. */
export const channelTitle = (
  channel: Pick<Channel, "name" | "memberBotIds">,
  nameOf: (botId: string) => string | null
): string => {
  if (channel.name.trim().length > 0) return channel.name.trim();
  return channel.memberBotIds
    .map(nameOf)
    .filter((name): name is string => name != null)
    .join(", ");
};

/** The agreed points of a discussion's summing-up: its numbered lines, else all of it. */
export const agreedItems = (text: string): string[] => {
  const items = text
    .split("\n")
    // The line trimmed, then "1." or "1)" and one space: no two parts of the
    // pattern compete for the same characters.
    .map((line) =>
      /^\d+[.)] (.*)$/.exec(line.trim())?.[1]?.replace(/\*\*/g, "").trim()
    )
    .filter((line): line is string => line != null && line.length > 0);
  return items.length > 0 ? items : [text.trim()];
};
