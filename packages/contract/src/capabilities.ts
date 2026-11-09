/**
 * What the user can do with this app, one entry per thing they ask for, and
 * the one renderer that says it for a caller. `bot_help`, tool results and the
 * template checks read it; nothing here reaches a system prompt. Each entry
 * has the desktop app's way and the web version's (bot.abacus.ai), and reads
 * as now, after one step, or not from this chat, from the caller's own tools,
 * linked chat apps, connectors and plan.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";

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

export type CapabilitySurface = "desktop" | "hosted";

/** What an auto-reply lane never does: its own rules and its entry both say it in these words. */
export const AUTO_REPLY_NEVER =
  "start new topics or conversations, make plans, run an interview or questionnaire, or report back to the user";

/** How one surface does an entry. */
export interface CapabilityWay {
  /** How it is done, once available: one line, or one per chat app. Empty: only the plan step. */
  does: string | Readonly<Partial<Record<HomeChannel, string>>>;
  /** Tools that do it from a chat: any one listed for the caller is enough. */
  tools?: readonly string[];
  /** Where it is done when this chat has none of `tools`. */
  elsewhere?: string;
  /** Needs a linked chat app; the step that links one. */
  linkStep?: string;
  /** Needs this registry connector connected. */
  connector?: string;
  /** Only a paid plan has it on this surface. */
  paidOnly?: boolean;
  /** A paid plan answers the rest: billing_plan words it (plan-asks.ts). */
  planAsk?: boolean;
}

export interface Capability {
  id: CapabilityId;
  /** How the user puts it. */
  ask: string;
  topic: CapabilityTopic;
  desktop: CapabilityWay;
  /** The web version's way; null when only the desktop app does it. */
  hosted: CapabilityWay | null;
  doesNot?: string;
  /** What to do instead of what it does not do. */
  instead?: string;
  /** A product it is mistaken for. */
  not?: string;
}

const AUTO_REPLY_TOOLS = [
  "auto_reply",
  "whatsapp_auto_reply",
  "telegram_auto_reply",
  "discord_auto_reply",
];

const DESKTOP_LINK = "link it under Messaging";
const HOSTED_LINK =
  "connect WhatsApp in the app, which links their WhatsApp to AbacusAI Bot's own number";

/** The account connectors the registry lists, by count and a few names. */
const accountConnectors = CONNECTORS.filter(
  (connector) => connector.kind !== "messaging"
);
const CONNECTORS_ASK = `connect an account or service (${accountConnectors.length} on the list, such as ${accountConnectors
  .slice(0, 4)
  .map((connector) => connector.name)
  .join(", ")})`;

const CONNECT_WAY: CapabilityWay = {
  does: "the user connects it on the Connectors page, or you ask for it with connect_connector",
  tools: ["connect_connector"],
  elsewhere: "on the Connectors page",
};

const MEDIA_WAY: CapabilityWay = {
  does: "call paid_feature first: it says what makes it on their plan and where",
  tools: ["paid_feature"],
  elsewhere: "in a main chat or a bot's chat",
};

const MODELS_WAY: CapabilityWay = {
  does: "the model menu picks the model per chat, bot and routine; a provider's own API key is added on the Models page",
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "phone-chat",
    ask: "use or control the bot from their phone",
    topic: "chat_apps",
    desktop: {
      does: {
        whatsapp:
          'in WhatsApp on their phone they open their own "Message yourself" chat (the chat with their own number) and write there; this app\'s WhatsApp bot answers in that chat, from any phone signed in to that account, with no other app needed',
        telegram:
          "in Telegram they write to the Abacus AI bot (linked under Messaging → Telegram); this app's Telegram bot answers in that chat",
        discord:
          "in Discord they DM the Abacus AI bot (linked under Messaging → Discord); this app's Discord bot answers there",
      },
      linkStep: DESKTOP_LINK,
    },
    hosted: {
      does: {
        whatsapp:
          "in WhatsApp on their phone they message AbacusAI Bot's own number; the web version answers there, with no computer of theirs needed (Telegram and Discord are the desktop app's)",
      },
      linkStep: HOSTED_LINK,
    },
    not: "the ChatLLM mobile app is another Abacus AI product and holds no link to this app",
  },
  {
    id: "auto-reply",
    ask: "have chosen contacts answered automatically",
    topic: "chat_apps",
    desktop: {
      does: "in a bot's chat, auto-reply answers each message a chosen person sends, in the user's voice",
      tools: AUTO_REPLY_TOOLS,
      elsewhere: "in a bot's own chat (Bots), where it is switched on",
      linkStep: DESKTOP_LINK,
    },
    hosted: null,
    doesNot: `It does not ${AUTO_REPLY_NEVER} on its own: never promise the user it will`,
    instead:
      "to ask a contact something, send it yourself from this chat and read their answers here, and tell the user plainly that you did",
  },
  {
    id: "send-read-messages",
    ask: "send or read messages in a chat app",
    topic: "chat_apps",
    desktop: {
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
      linkStep: DESKTOP_LINK,
    },
    hosted: {
      does: "send_to_whatsapp messages the user on WhatsApp through AbacusAI Bot's number, and reaches only them; messaging other people and reading their chats is the desktop app's",
      linkStep: HOSTED_LINK,
    },
  },
  {
    id: "whatsapp-business",
    ask: "use WhatsApp Business",
    topic: "chat_apps",
    desktop: {
      does: "a business number connects as its own connector (WhatsApp Business, on the Connectors page) for messages and templates; a WhatsApp Business app on the phone links like WhatsApp, by scanning the QR code from its Linked devices",
      connector: "abacus-whatsappbusiness",
    },
    hosted: {
      does: "a business number connects as its own connector (WhatsApp Business, on the Connectors page) for messages and templates",
      connector: "abacus-whatsappbusiness",
    },
  },
  {
    id: "routines",
    ask: "have something run on a schedule, once later, or on a webhook",
    topic: "routines",
    desktop: {
      does: "a routine, made with cronjob, runs in this app while the computer is on; bot_help's routines topic has the rest",
      tools: ["cronjob"],
      elsewhere: "in a main chat or a bot's chat, or the Routines page",
    },
    hosted: {
      does: "a routine, made with cronjob, runs on the server with their computer off; bot_help's routines topic has the rest",
      tools: ["cronjob"],
      elsewhere: "in a main chat or a bot's chat, or the Routines page",
      paidOnly: true,
    },
  },
  {
    id: "always-on",
    ask: "keep things running with the computer off, or 24/7",
    topic: "routines",
    desktop: {
      does: "this app runs while the computer is on and the app is open",
      planAsk: true,
    },
    hosted: {
      does: "the web version runs on the server, so its chats answer with their computer off",
      planAsk: true,
    },
  },
  {
    id: "publish",
    ask: "a live, public link for something built here",
    topic: "capabilities",
    desktop: {
      does: "this app builds it and runs it on this computer",
      planAsk: true,
    },
    hosted: { does: "", planAsk: true },
  },
  {
    id: "media",
    ask: "make images, video, speech or audio",
    topic: "capabilities",
    desktop: MEDIA_WAY,
    hosted: MEDIA_WAY,
  },
  {
    id: "connectors",
    ask: CONNECTORS_ASK,
    topic: "connectors",
    desktop: CONNECT_WAY,
    hosted: CONNECT_WAY,
  },
  {
    id: "models-and-keys",
    ask: "pick a model, or use their own provider key",
    topic: "models",
    desktop: MODELS_WAY,
    hosted: MODELS_WAY,
  },
];

/** What the caller has, read when the question is asked. */
export interface CapabilityState {
  surface: CapabilitySurface;
  /** The account's plan (models.ts AbacusPlanTier); unknown reads as free. */
  tier: "free" | "basic" | "paid" | "unknown";
  /** Which chat apps' own chats are linked now (their self lane); null when unreadable. */
  chatApps: Readonly<Partial<Record<HomeChannel, boolean>>> | null;
  /** Registry connector states by id; null when unreadable. */
  connectors: Readonly<
    Record<string, { state: string; reason?: string }>
  > | null;
  /** The tool names this caller is listed. */
  tools: ReadonlySet<string>;
}

const CHAT_APP_NAMES: Readonly<Record<HomeChannel, string>> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

const paid = (state: CapabilityState): boolean =>
  state.tier === "basic" || state.tier === "paid";

const anyLinked = (state: CapabilityState): boolean =>
  state.chatApps == null ||
  Object.values(state.chatApps).some((value) => value === true);

const doesText = (way: CapabilityWay, state: CapabilityState): string => {
  if (typeof way.does === "string") return way.does;
  return (Object.entries(way.does) as Array<[HomeChannel, string]>)
    .map(([app, how]) =>
      state.chatApps?.[app] === false
        ? `${CHAT_APP_NAMES[app]} (after one step: ${way.linkStep ?? DESKTOP_LINK}): ${how}`
        : `${CHAT_APP_NAMES[app]}: ${how}`
    )
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
  const way = state.surface === "hosted" ? entry.hosted : entry.desktop;
  if (way == null)
    return `${head}Not on the web version: the desktop app does it.${not}`;
  const does = doesText(way, state);
  if (way.planAsk === true) {
    const now = does.length > 0 ? `Yes, now: ${does}. ` : "";
    return paid(state)
      ? `${head}${now}Their paid plan gives the rest in Abacus AI Agent on the web: call billing_plan and answer from it; never a flat no.`
      : `${head}${now}After one step (a paid plan) the rest: call billing_plan with upgrade: true and answer from it; never a flat no.`;
  }
  if (way.paidOnly === true && !paid(state))
    return `${head}After one step (a paid plan): ${does}. Call billing_plan with upgrade: true and answer from it; never a flat no.`;
  if (way.connector != null && state.connectors != null) {
    const status = state.connectors[way.connector];
    if (status?.state === "unavailable")
      return `${head}Not on this account right now${status.reason != null ? ` (${status.reason})` : ""}: say so, and what it would do: ${does}.`;
    if (status?.state !== "connected")
      return `${head}After one step (connect it on the Connectors page${state.tools.has("connect_connector") ? ", or ask with connect_connector" : ""}): ${does}.`;
  }
  if (way.tools != null && !way.tools.some((tool) => state.tools.has(tool)))
    return `${head}Not from this chat: ${way.elsewhere ?? "elsewhere in the app"}.${extra}${not}`;
  if (way.linkStep != null && typeof way.does === "string" && !anyLinked(state))
    return `${head}After one step (${way.linkStep}): ${does}.${extra}${not}`;
  return `${head}Yes, now: ${does}.${extra}${not}`;
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

/** An entry as a tool result says it, at the moment of action (the desktop's way). */
export function capabilityNote(id: CapabilityId): string {
  const entry = capabilityById(id);
  const does = entry.desktop.does;
  return [
    `What it does: ${typeof does === "string" ? does : Object.values(does).join("; ")}.`,
    entry.doesNot != null ? `${entry.doesNot}.` : null,
    entry.instead != null ? `Instead: ${entry.instead}.` : null,
  ]
    .filter((part): part is string => part != null)
    .join(" ");
}

/** Where the user writes to the bot from their phone on a chat app, on this surface. */
export const phoneChatRoute = (
  app: HomeChannel,
  surface: CapabilitySurface = "desktop"
): string => {
  const entry = capabilityById("phone-chat");
  const route = (way: CapabilityWay | null): string | undefined =>
    way == null || typeof way.does === "string" ? undefined : way.does[app];
  return (
    (surface === "hosted" ? route(entry.hosted) : undefined) ??
    route(entry.desktop) ??
    ""
  );
};
