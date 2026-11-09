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
  /** Optional for records written before accessories. */
  avatarAccessory?: AvatarAccessoryId | null;
  /** The chat's wallpaper (BOT_WALLPAPER_IDS); null or absent is none. */
  wallpaper?: BotWallpaperId | null;
  /** Null means the active workspace when first opened. */
  workspaceId: string | null;
  /** The forever chat. Null until first opened, or after its session died. */
  sessionId: string | null;
  /**
   * When the bot was told to speak first in that chat. Null until it was:
   * a chat whose start failed is opened again with the kickstart it is owed.
   */
  kickstartedAt?: number | null;
  /**
   * Legacy: the hidden self-lane bots older installs minted per chat app.
   * Main adopts them as that app's agent at startup and clears it
   * (BotService.adoptChannelBots); the app's own chat now goes to its home
   * bot, an ordinary bot.
   */
  channel?: string | null;
  /**
   * A chat-app agent's home (made from the WhatsApp, Telegram or Discord
   * Agent template): where the user talks to it. Its standing prompt says so.
   */
  homeChannel?: HomeChannel | null;
  /** The template it was made from (BotTemplate.id); absent for a bot the user wrote. */
  templateId?: string | null;
  /** Per bot rather than per machine: the bot loop is tuned for cheap models. */
  model: string | null;
  /**
   * The user's standing yes: this bot may ask other bots and pass them work
   * without the user saying so each time, still only while answering them.
   * Off unless the user turns it on.
   */
  delegatesFreely?: boolean;
  /**
   * Until when the platform serves this bot's runs on the house (the Chief of
   * Staff made at onboarding drafts the inbox before the account spends a
   * credit). Null for every bot the user made.
   */
  sponsoredUntil?: number | null;
  createdAt: number;
  updatedAt: number;
}

/** How long a sponsored first run (a bot's or a session's) stays on the house; the platform enforces its own window and spend cap too. */
export const SPONSORED_FIRST_RUN_WINDOW_MS = 30 * 60 * 1000;
/** The marker the app sends with a sponsored run's requests, as the platform expects it. */
export const SPONSORED_RUN_MARKER = "cos-first-run";

/** The chat apps a bot can call home. */
export const HOME_CHANNELS = ["whatsapp", "telegram", "discord"] as const;
export type HomeChannel = (typeof HOME_CHANNELS)[number];

/** Each chat app's name as the agent and its prompts say it. */
export const HOME_CHANNEL_NAMES: Record<HomeChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

export interface BotCreateInput {
  name: string;
  title?: string;
  description: string;
  persona?: string;
  avatarColor?: string;
  avatarShape?: string;
  avatarAccessory?: AvatarAccessoryId | null;
  wallpaper?: BotWallpaperId | null;
  workspaceId?: string | null;
  model?: string | null;
  channel?: string | null;
  homeChannel?: HomeChannel | null;
  templateId?: string | null;
  /** Make this bot's first runs free of charge for SPONSORED_FIRST_RUN_WINDOW_MS; onboarding's first bot only. */
  sponsoredFirstRun?: boolean;
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
    | "avatarAccessory"
    | "wallpaper"
    | "model"
    | "delegatesFreely"
    | "channel"
    // Main only (adopting a legacy channel bot); the renderer cannot send it.
    | "homeChannel"
  >
>;

/**
 * The chat wallpapers a bot can wear (spec 03 §24, WhatsApp-style): built-in
 * seamless tiles tinted from the theme, a solid tint from the bot's accent,
 * or none (the default). The renderer draws them; the id is all that is
 * stored.
 */
export const BOT_WALLPAPER_IDS = [
  "none",
  "doodle",
  "dots",
  "grid",
  "waves",
  "solid",
] as const;
export type BotWallpaperId = (typeof BOT_WALLPAPER_IDS)[number];

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
  BOT_AVATAR_COLORS[nameHash(name) % BOT_AVATAR_COLORS.length]!;

export const defaultAvatarShape = (name: string): string =>
  // A different stride than the color, so collisions on one axis differ.
  BOT_AVATAR_SHAPES[(nameHash(name) >> 3) % BOT_AVATAR_SHAPES.length]!;

/** Up to two initials, for rendering over the avatar swatch. */

/** Spec 03 §14.1 accessories, including the empty look. */
export const AVATAR_ACCESSORY_IDS = [
  "none",
  "glasses",
  "shades",
  "bow",
  "cap",
  "headphones",
  "antenna",
  "crown",
  "monocle",
] as const;

export type AvatarAccessoryId = (typeof AVATAR_ACCESSORY_IDS)[number];
