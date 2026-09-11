/**
 * Bots: a persona plus one long-lived "forever chat" whose system prompt
 * carries the bot's name, role and mission. The record stores the chat's
 * session id; a bot whose session was deleted gets a fresh one on next open,
 * never an error or a silent duplicate.
 */

export interface Bot {
  id: string;
  /** Also the name the agent answers to. */
  name: string;
  /** Short role label, e.g. "Research Scout". */
  title: string;
  /** The mission; becomes the bot's standing prompt. */
  description: string;
  /** How it speaks. Empty means the model's own manner. */
  persona: string;
  /** Swatch from BOT_AVATAR_COLORS. */
  avatarColor: string;
  /** One of BOT_AVATAR_SHAPES. */
  avatarShape: string;
  /** Null means the active workspace when first opened. */
  workspaceId: string | null;
  /** The forever chat. Null until first opened, or after its session died. */
  sessionId: string | null;
  /**
   * Set on the self-lane bots minted when a chat channel links: the app the
   * conversation happens in. Such a bot's chat is a window, not a composer.
   */
  channel?: string | null;
  /** Per bot rather than per machine: the bot loop is tuned for cheap models. */
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface BotCreateInput {
  name: string;
  title?: string;
  description: string;
  persona?: string;
  avatarColor?: string;
  avatarShape?: string;
  workspaceId?: string | null;
  model?: string | null;
  channel?: string | null;
}

// What an edit changed that the bot should hear about in its chat, once. Name,
// look and model change nothing about how it behaves.
export interface BotChangeNotice {
  mission?: boolean;
  persona?: boolean;
  /** The new check-in schedule in words ("weekdays at 09:00", "off"). */
  checkIn?: string;
}

export type BotUpdateInput = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "persona"
    | "avatarColor"
    | "avatarShape"
    | "model"
    | "channel"
  >
>;

/** What opening a bot's chat resolves to. */
export interface BotChatHandle {
  botId: string;
  workspaceId: string;
  sessionId: string;
}

export const MAX_BOTS = 50;
// A name is a label worn by the sidebar, roster and handle, not a prompt; the
// mission belongs in the mission field. The store slices defensively too.
export const MAX_BOT_NAME = 30;
export const MAX_BOT_TITLE = 80;
export const MAX_BOT_DESCRIPTION = 4_000;
export const MAX_BOT_PERSONA = 1_000;

// The brand's purple leads the swatches; the rest run warm to cool.
export const BOT_AVATAR_COLORS = [
  "#a855f7",
  "#b08968",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#ec4899",
  "#9ca3af",
] as const;

// Silhouette ids in picker order; BotAvatar maps each to a fixed outline. The
// first is what a bot with no name yet wears, so it is the round face.
export const BOT_AVATAR_SHAPES = [
  "cone",
  "pebble",
  "cloud",
  "tablet",
  "squircle",
  "drop",
  "pill",
  "blob",
] as const;

const nameHash = (name: string): number => {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
};

/** Deterministic defaults so a bot keeps its look across edits. */
export const defaultAvatarColor = (name: string): string =>
  BOT_AVATAR_COLORS[nameHash(name) % BOT_AVATAR_COLORS.length];

export const defaultAvatarShape = (name: string): string =>
  // A different stride than the color, so collisions on one axis differ.
  BOT_AVATAR_SHAPES[(nameHash(name) >> 3) % BOT_AVATAR_SHAPES.length];

/** Up to two initials, for rendering over the avatar swatch. */
export const botInitials = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
};
