/**
 * The messaging gateway contract, shared by main, preload, and renderer: a
 * declarative catalog of platforms (credential fields, enable flag, live
 * state, pairing allowlist) so the pane can render a platform it knows nothing
 * specific about. Connectors run in the main process (`services/messaging/`).
 */

export const MESSAGING_PLATFORM_IDS = [
  "telegram",
  "discord",
  "whatsapp",
  // The shared "Abacus AI" bots, paired by a one-time code: separate lanes
  // from the user's own accounts.
  "abacus_discord",
  "abacus_telegram",
] as const;

export type MessagingPlatformId = (typeof MESSAGING_PLATFORM_IDS)[number];

// Slack is deliberately absent: it is the account connector, like Gmail, and
// a second local Slack put contradictory statements in one transcript.
export const AGENT_LINKABLE_CHAT_APPS: readonly MessagingPlatformId[] = [
  "telegram",
  "discord",
  "whatsapp",
];

/** Platforms rendered as a section of another platform's card. */
export const SHARED_BOT_PLATFORM_OF: Partial<
  Record<MessagingPlatformId, MessagingPlatformId>
> = { discord: "abacus_discord", telegram: "abacus_telegram" };

// A platform id as a model should read it: the bare "abacus_telegram" reads to
// a bot as "Telegram is connected" over an unlinked Telegram.
export const describePlatformForAgent = (id: MessagingPlatformId): string => {
  switch (id) {
    case "abacus_discord":
      return "abacus_discord (the shared Abacus AI Discord bot: DMs with the user only, not the user's Discord account, servers or channels)";
    case "abacus_telegram":
      return "abacus_telegram (the shared Abacus AI Telegram bot: DMs with the user only, not the user's Telegram account)";
    default:
      return id;
  }
};

// The account API's names for the shared bots. Reported under abacus_*; listed
// again as "telegram" they would read as the user's own Telegram.
export const SHARED_BOT_ACCOUNT_SERVICES: ReadonlySet<string> = new Set([
  "telegram",
  "discord",
]);

// The live lanes a conversation is told about. A shared bot lane counts only
// while the user's own account on that app is linked; the lane still works
// for DMs either way, this is only what is said.
export const reportableLivePlatforms = (
  live: readonly MessagingPlatformId[]
): MessagingPlatformId[] =>
  live.filter((id) => {
    const base = (
      Object.entries(SHARED_BOT_PLATFORM_OF) as [
        MessagingPlatformId,
        MessagingPlatformId,
      ][]
    ).find(([, shared]) => shared === id)?.[0];
    return base == null || live.includes(base);
  });

export const isMessagingPlatformId = (
  value: unknown
): value is MessagingPlatformId =>
  typeof value === "string" &&
  (MESSAGING_PLATFORM_IDS as readonly string[]).includes(value);

/**
 * `pending_restart`: credentials changed on disk but the running connector
 * holds the old ones. `needs_login`: healthy and waiting on a human (QR, login
 * form); not `error`, so the gateway must not restart it and pop the window
 * back up. `syncing`: linked but the platform has not handed over the account
 * and chats yet (WhatsApp Web takes minutes), so a send that cannot happen
 * yet reads as syncing rather than broken.
 */
export type MessagingPlatformState =
  | "disabled"
  | "not_configured"
  | "pending_restart"
  | "connecting"
  | "needs_login"
  | "rate_limited"
  | "syncing"
  | "connected"
  | "error";

// `key` doubles as the storage key and an env-var name; the environment wins
// over the stored value, as it does for provider API keys.
export type MessagingFieldSpec = {
  key: string;
  /** i18n key under `messaging.fields`; falls back to `key` when absent. */
  labelKey: string;
  required: boolean;
  /** Rendered as a password input and redacted on the way back to the UI. */
  secret: boolean;
  placeholder?: string;
  /** Collapsed behind the "Advanced" disclosure. */
  advanced?: boolean;
};

export type MessagingFieldInfo = MessagingFieldSpec & {
  isSet: boolean;
  /** e.g. `••••••1234`, never the real secret. */
  redactedValue: string | null;
  /** The value came from the process environment, not our file. */
  fromEnv: boolean;
};

/** This user's pairing with a shared Abacus-owned bot. */
export type SharedChannelLink = {
  status: "unlinked" | "pending" | "linked" | "unavailable";
  displayName?: string | null;
  deepLink?: string;
  /** The pairing code to send the bot. */
  code?: string;
  instructions?: string;
  /** Unix seconds; the code is single-use and short-lived. */
  expiresAt?: number;
  /** The deep link as a QR image (data: URL). */
  qrDataUrl?: string;
  botProfileUrl?: string;
  error?: string;
};

export type MessagingPlatformInfo = {
  id: MessagingPlatformId;
  /** i18n key under `messaging.platforms`. */
  nameKey: string;
  docsUrl: string;
  enabled: boolean;
  /** Every required field has a value. */
  configured: boolean;
  state: MessagingPlatformState;
  errorMessage: string | null;
  fields: MessagingFieldInfo[];
  /** Senders waiting for approval, for the list-row badge. */
  pendingCount: number;
  /** Shared-bot platforms only. */
  sharedLink?: SharedChannelLink;
};

// Pairing is the whole security model: an approved sender can drive an agent
// with tool access on this machine, so an unknown sender lands as `pending`.
export type MessagingPairedUser = {
  platform: MessagingPlatformId;
  /** Platform-native id. Only unique within a platform. */
  userId: string;
  userName: string | null;
  /** Where to reply: chat/channel/thread id. */
  chatId: string;
  status: "pending" | "approved" | "paused";
  /** "bot" rows live under the bot in the Bots pane, not the manual pairing list. */
  managedBy?: "bot";
  /** The bot answering this sender. Per row: one global pointer let a second bot's setup hand the sender to the first. */
  botId?: string;
  firstSeenAt: string;
  /** The message that triggered the pairing request. */
  firstMessage: string | null;
};

export type MessagingSnapshot = {
  platforms: MessagingPlatformInfo[];
  pending: MessagingPairedUser[];
  approved: MessagingPairedUser[];
  /** Every sender a bot answers automatically, paused ones included. */
  autoReplies: MessagingPairedUser[];
  /** Global kill switch: when false, no connector runs. */
  gatewayEnabled: boolean;
  /**
   * Remote turns run unattended. On, an approved pairing is equivalent to shell
   * access; off, risky tools stall waiting for approval in the app.
   */
  autoApproveTools: boolean;
  /**
   * Off by default: the gateway only records what arrives, since connecting an
   * account must not by itself put a bot on the user's number.
   */
  respondToInbound: boolean;
  /** Null until the user picks one. */
  workspaceId: string | null;
  /** Deliver inbound into this bot's forever chat; null mints per-sender sessions. */
  botId: string | null;
};

export type UpdateMessagingPlatformRequest = {
  platformId: MessagingPlatformId;
  enabled?: boolean;
  /** Field key -> new value. Empty string clears the stored value. */
  values?: Record<string, string>;
};

export type MessagingPairingDecisionRequest = {
  platformId: MessagingPlatformId;
  userId: string;
  decision: "approve" | "revoke" | "pause" | "resume";
};

export type UpdateMessagingSettingsRequest = {
  gatewayEnabled?: boolean;
  autoApproveTools?: boolean;
  respondToInbound?: boolean;
  workspaceId?: string | null;
  botId?: string | null;
};

export const MESSAGING_PLATFORM_CATALOG: {
  id: MessagingPlatformId;
  nameKey: string;
  docsUrl: string;
  fields: MessagingFieldSpec[];
}[] = [
  {
    id: "telegram",
    nameKey: "telegram",
    // Signs in through Telegram's own web app; no stored token. Messages to
    // the user travel the shared Abacus AI bot's lane (abacus_telegram).
    docsUrl: "https://web.telegram.org",
    fields: [],
  },
  {
    id: "discord",
    nameKey: "discord",
    docsUrl: "https://support.discord.com/hc/en-us/articles/213041045",
    // Signs in through Discord's own web app in a window; no stored token.
    fields: [],
  },
  {
    id: "abacus_discord",
    nameKey: "abacusDiscord",
    docsUrl: "https://discord.com/",
    // The bot is Abacus's; pairing is a /link code, so the Abacus key is the
    // only setup.
    fields: [],
  },
  {
    id: "abacus_telegram",
    nameKey: "abacusTelegram",
    docsUrl: "https://telegram.org/",
    fields: [],
  },
  {
    id: "whatsapp",
    nameKey: "whatsapp",
    docsUrl: "https://web.whatsapp.com",
    // Links through web.whatsapp.com in a window; no stored token.
    fields: [],
  },
];

export const messagingPlatformSpec = (
  id: MessagingPlatformId
): (typeof MESSAGING_PLATFORM_CATALOG)[number] | undefined =>
  MESSAGING_PLATFORM_CATALOG.find((entry) => entry.id === id);

/** `••••••cdef`: enough to recognise a key without revealing it. */
export const redactSecret = (value: string): string => {
  const tail = value.slice(-4);
  return `${"•".repeat(6)}${tail}`;
};

/**
 * Platforms whose setup is unfinished until the shared Abacus AI bot lane is
 * linked too: signing in lets the agent act as you, linking lets you reach it
 * from a phone.
 */
export const SHARED_LINK_REQUIRED: ReadonlySet<MessagingPlatformId> =
  new Set<MessagingPlatformId>(["discord", "telegram"]);

/** Whether `platformId` still owes its shared-bot link, which keeps it off "Connected". */
export const sharedLinkPending = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  if (!SHARED_LINK_REQUIRED.has(platformId)) return false;
  const sharedId = SHARED_BOT_PLATFORM_OF[platformId];
  if (sharedId == null) return false;
  const shared = snapshot?.platforms.find((entry) => entry.id === sharedId);
  // No lane offered: requiring a step nobody can complete would strand the
  // card on "finish linking" forever.
  if (shared == null) return false;
  const status = shared.sharedLink?.status;
  if (status === "unavailable") return false;
  return status !== "linked";
};

/**
 * Installed means enabled and configured, not connected: a card that flipped
 * on every reconnect would read as broken, but the enabled flag outlives its
 * credentials and alone is not enough.
 */
export const isMessagingPlatformInstalled = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  const platform = snapshot?.platforms.find((entry) => entry.id === platformId);
  if (platform?.enabled === true && platform.configured) return true;
  // The Discord card is also installed when only its shared-bot lane is.
  const shared = SHARED_BOT_PLATFORM_OF[platformId];
  return shared != null && isMessagingPlatformInstalled(snapshot, shared);
};

/** Actually connected, the bar for anything that says "Connected". */
export const isMessagingPlatformConnected = (
  snapshot: MessagingSnapshot | null,
  platformId: MessagingPlatformId
): boolean => {
  // Half of Discord's setup is not Discord connected. See SHARED_LINK_REQUIRED.
  if (sharedLinkPending(snapshot, platformId)) return false;
  const state = snapshot?.platforms.find(
    (entry) => entry.id === platformId
  )?.state;
  if (state === "connected" || state === "syncing") return true;
  const shared = SHARED_BOT_PLATFORM_OF[platformId];
  return shared != null && isMessagingPlatformConnected(snapshot, shared);
};
