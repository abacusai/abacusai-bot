/**
 * What the user can do with this app, one entry per thing they ask for, and
 * the one renderer that says it for a caller. `bot_help`, tool results and the
 * template checks read it; nothing here reaches a system prompt. An entry
 * whose tools the caller lacks reads "not from this chat", so a chat is never
 * told it can do what its tools cannot, nor told no when they can.
 * Imports types only, so main, the agent and the hosted app all read it.
 */
import type { HomeChannel } from "./bots";

export type CapabilityId =
  | "phone-chat"
  | "auto-reply"
  | "send-read-messages"
  | "whatsapp-business"
  | "routines"
  | "always-on"
  | "publish"
  | "media"
  | "connectors"
  | "models-and-keys";

/** The bot_help topic an entry is listed under. */
export type CapabilityTopic =
  | "chat_apps"
  | "capabilities"
  | "routines"
  | "connectors"
  | "models";

/** What an auto-reply lane never does: its own rules and its entry both say it in these words. */
export const AUTO_REPLY_NEVER =
  "start new topics or conversations, make plans, run an interview or questionnaire, or report back to the user";

export interface Capability {
  id: CapabilityId;
  /** How the user puts it. */
  ask: string;
  topic: CapabilityTopic;
  /** How it is done, once available: one line, or one per chat app. */
  does: string | Readonly<Record<HomeChannel, string>>;
  doesNot?: string;
  /** What to do instead of what it does not do. */
  instead?: string;
  /** Tools that do it from a chat: any one listed for the caller is enough. */
  tools?: readonly string[];
  /** Where it is done when this chat has none of `tools`. */
  elsewhere?: string;
  /** Needs a linked chat app. */
  chatApp?: boolean;
  /** Only the desktop app does it. */
  desktopOnly?: boolean;
  /** A paid plan answers it in full: billing_plan words it (plan-asks.ts). */
  planAsk?: boolean;
  /** A product it is mistaken for. */
  not?: string;
}

const AUTO_REPLY_TOOLS = [
  "auto_reply",
  "whatsapp_auto_reply",
  "telegram_auto_reply",
  "discord_auto_reply",
];

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "phone-chat",
    ask: "use or control the bot from their phone",
    topic: "chat_apps",
    does: {
      whatsapp:
        'in WhatsApp on their phone they open their own "Message yourself" chat (the chat with their own number) and write there; this app\'s WhatsApp bot answers in that chat, from any phone signed in to that account, with no other app needed',
      telegram:
        "in Telegram they write to the Abacus AI bot (linked under Messaging → Telegram); this app's Telegram bot answers in that chat",
      discord:
        "in Discord they DM the Abacus AI bot (linked under Messaging → Discord); this app's Discord bot answers there",
    },
    chatApp: true,
    desktopOnly: true,
    not: "the ChatLLM mobile app is another Abacus AI product and holds no link to this app",
  },
  {
    id: "auto-reply",
    ask: "have chosen contacts answered automatically",
    topic: "chat_apps",
    does: "in a bot's chat, auto-reply answers each message a chosen person sends, in the user's voice",
    doesNot: `It does not ${AUTO_REPLY_NEVER} on its own: never promise the user it will`,
    instead:
      "to ask a contact something, send it yourself from this chat and read their answers here, and tell the user plainly that you did",
    tools: AUTO_REPLY_TOOLS,
    elsewhere: "in a bot's own chat (Bots), where it is switched on",
    chatApp: true,
    desktopOnly: true,
  },
  {
    id: "send-read-messages",
    ask: "send or read messages in a chat app",
    topic: "chat_apps",
    does: "send a message to a contact or to themselves, and read recent chats, from this chat",
    tools: [
      "send_chat_message",
      "send_whatsapp_message",
      "send_telegram_message",
      "send_discord_message",
      "read_chat_messages",
      "read_whatsapp_messages",
      "read_telegram_messages",
      "read_discord_messages",
    ],
    elsewhere: "in a main chat or a bot's chat in the app",
    chatApp: true,
  },
  {
    id: "whatsapp-business",
    ask: "use WhatsApp Business",
    topic: "chat_apps",
    does: "a business number connects as its own connector (WhatsApp Business, on the Connectors page) for messages and templates; a WhatsApp Business app on the phone links like WhatsApp, by scanning the QR code from its Linked devices",
  },
  {
    id: "routines",
    ask: "have something run on a schedule, once later, or on a webhook",
    topic: "routines",
    does: "a routine, made with cronjob; where and when it runs is bot_help's routines topic",
    tools: ["cronjob"],
    elsewhere: "in a main chat or a bot's chat, or the Routines page",
  },
  {
    id: "always-on",
    ask: "keep things running with the computer off, or 24/7",
    topic: "routines",
    does: "this app runs while the computer is on and the app is open",
    planAsk: true,
  },
  {
    id: "publish",
    ask: "a live, public link for something built here",
    topic: "capabilities",
    does: "this app builds it and runs it on this computer",
    planAsk: true,
  },
  {
    id: "media",
    ask: "make images, video, speech or audio",
    topic: "capabilities",
    does: "call paid_feature first: it says what makes it on their plan and where",
    tools: ["paid_feature"],
    elsewhere: "in a main chat or a bot's chat",
  },
  {
    id: "connectors",
    ask: "connect an account or service (Gmail, Slack, Drive and 100+ more)",
    topic: "connectors",
    does: "the user connects it on the Connectors page, or you ask for it with connect_connector",
    tools: ["connect_connector"],
    elsewhere: "on the Connectors page",
  },
  {
    id: "models-and-keys",
    ask: "pick a model, or use their own provider key",
    topic: "models",
    does: "the model menu picks the model per chat, bot and routine; a provider's own API key is added on the Models page",
  },
];

/** What the caller has, read when the question is asked. */
export interface CapabilityState {
  surface: "desktop" | "hosted";
  /** The account's plan (models.ts AbacusPlanTier); unknown reads as free. */
  tier: "free" | "basic" | "paid" | "unknown";
  /** Which chat apps are linked now; null when that cannot be read. */
  chatApps: Readonly<Partial<Record<HomeChannel, boolean>>> | null;
  /** The tool names this caller is listed. */
  tools: ReadonlySet<string>;
}

const CHAT_APP_NAMES: Readonly<Record<HomeChannel, string>> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

const doesText = (entry: Capability, state: CapabilityState): string => {
  if (typeof entry.does === "string") return entry.does;
  const apps = Object.keys(entry.does) as HomeChannel[];
  return apps
    .map((app) => {
      const how = (entry.does as Record<HomeChannel, string>)[app];
      const linked = state.chatApps?.[app];
      return linked === false
        ? `${CHAT_APP_NAMES[app]} (after one step: link it under Messaging): ${how}`
        : `${CHAT_APP_NAMES[app]}: ${how}`;
    })
    .join(". ");
};

/** One entry as the caller can act on it: now, after one step, or not from this chat. */
export function capabilityLine(
  entry: Capability,
  state: CapabilityState
): string {
  const extra = [entry.doesNot, entry.instead && `Instead: ${entry.instead}`]
    .filter((part): part is string => part != null && part.length > 0)
    .map((part) => ` ${part}.`)
    .join("");
  const not = entry.not != null ? ` Not this: ${entry.not}.` : "";
  const head = `- ${entry.ask}: `;
  if (entry.desktopOnly === true && state.surface === "hosted")
    return `${head}Not on the web version: the desktop app does it.${not}`;
  if (entry.planAsk === true)
    return state.tier === "basic" || state.tier === "paid"
      ? `${head}Yes, now: ${entry.does}. Their paid plan gives the rest in Abacus AI Agent on the web: call billing_plan and answer from it; never a flat no.`
      : `${head}Yes, now: ${entry.does}. After one step (a paid plan) the rest: call billing_plan with upgrade: true and answer from it; never a flat no.`;
  if (entry.tools != null && !entry.tools.some((tool) => state.tools.has(tool)))
    return `${head}Not from this chat: ${entry.elsewhere ?? "elsewhere in the app"}.${extra}${not}`;
  const linked =
    state.chatApps == null ||
    Object.values(state.chatApps).some((value) => value === true);
  if (entry.chatApp === true && typeof entry.does === "string" && !linked)
    return `${head}After one step (link a chat app under Messaging): ${entry.does}.${extra}${not}`;
  return `${head}Yes, now: ${doesText(entry, state)}.${extra}${not}`;
}

/** The entries for a topic (or every one), rendered for this caller. */
export function capabilityFacts(
  state: CapabilityState,
  filter: { topic?: CapabilityTopic; ids?: readonly CapabilityId[] } = {}
): string[] {
  return CAPABILITIES.filter(
    (entry) =>
      (filter.topic == null || entry.topic === filter.topic) &&
      (filter.ids == null || filter.ids.includes(entry.id))
  ).map((entry) => capabilityLine(entry, state));
}

export const capabilityById = (id: CapabilityId): Capability => {
  const entry = CAPABILITIES.find((each) => each.id === id);
  if (entry == null) throw new Error(`No capability ${id}.`);
  return entry;
};

/** An entry as a tool result says it, at the moment of action. */
export function capabilityNote(id: CapabilityId): string {
  const entry = capabilityById(id);
  return [
    `What it does: ${typeof entry.does === "string" ? entry.does : Object.values(entry.does).join("; ")}.`,
    entry.doesNot != null ? `${entry.doesNot}.` : null,
    entry.instead != null ? `Instead: ${entry.instead}.` : null,
  ]
    .filter((part): part is string => part != null)
    .join(" ");
}

/** Where the user writes to the bot from their phone on a chat app. */
export const phoneChatRoute = (app: HomeChannel): string =>
  (capabilityById("phone-chat").does as Record<HomeChannel, string>)[app];
