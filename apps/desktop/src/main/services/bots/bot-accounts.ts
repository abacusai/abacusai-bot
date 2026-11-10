/**
 * Which accounts a bot's work goes through, and how it asks for them. One
 * rule for every bot: hand over a real result first, and ask for an account
 * only when a step needs it, one at a time. A template may name the one
 * account its job cannot start without (`requires`); its other accounts only
 * make the result better (`improves`), and until they are connected the bot
 * does the job its template describes for that case (`withoutAccounts`).
 */
import { connectorById } from "@abacus-ai/connectors/registry";
import { type Bot, HOME_CHANNEL_NAMES } from "@abacus-ai/contract/bots";
import { goalOfMission } from "@abacus-ai/contract/bots/check-in";
import {
  BOT_TEMPLATES,
  type BotTemplate,
} from "@abacus-ai/contract/bots/templates";
import { funnelId } from "@abacus-ai/contract/funnel";

export interface BotAccounts {
  /** The one account to ask for on the first turn, by name; null for most bots. */
  required: string | null;
  /** Its registry id, when it is a platform connector (not a home chat app). */
  requiredId: string | null;
  /** Accounts that make the result better, by name. */
  improves: string[];
  /** What the bot hands over while none of `improves` is connected. */
  withoutAccounts: string | null;
}

const nameOf = (id: string): string[] => {
  const name = connectorById(id)?.name;
  return name == null ? [] : [name];
};

const templateOf = (bot: Bot): BotTemplate | null =>
  BOT_TEMPLATES.find((row) => row.id === bot.templateId) ?? null;

export const botAccounts = (bot: Bot): BotAccounts => {
  const template = templateOf(bot);
  // A mission the user rewrote is theirs: the template's account that the job
  // "cannot start without" may not be in it, so it is only offered when it helps.
  const asWritten = template != null && bot.description === template.mission;
  const requiredId =
    asWritten && template.requires != null ? template.requires : null;
  const home =
    bot.homeChannel != null ? HOME_CHANNEL_NAMES[bot.homeChannel] : null;
  const required = home ?? (requiredId == null ? null : nameOf(requiredId)[0]);
  const improves = [
    ...new Set(
      [
        ...(!asWritten && template?.requires != null
          ? [template.requires]
          : []),
        ...(template?.improves ?? []),
      ].flatMap(nameOf)
    ),
  ].filter((name) => name !== required);
  return {
    required: required ?? null,
    requiredId: home == null ? requiredId : null,
    improves,
    withoutAccounts: asWritten ? (template.withoutAccounts ?? null) : null,
  };
};

/** The standing prompt's lines on accounts; static per bot, so the cached prompt holds. */
export const accountLines = (bot: Bot): string[] => {
  const { required, improves, withoutAccounts } = botAccounts(bot);
  const lines: string[] = [];
  // A chat-app agent's first reply is its home channel's (homeChannelLines).
  if (bot.homeChannel != null)
    lines.push(
      "",
      `**The one account your mission needs:** ${required}.`,
      "If the system reminder does not list it as connected, call",
      "connect_connector for it on your first turn. Never wait on it: you are",
      "told when it is connected."
    );
  else if (required != null)
    lines.push(
      "",
      `**The one account your mission needs:** ${required}.`,
      "If the system reminder does not list it as connected, call",
      "connect_connector for it on your first turn, and in that same reply hand",
      "over a short sample of what you will deliver once it is connected, made",
      "from the web or from what the user wrote. Never wait on it: end with two",
      "or three tasks you can do without it (suggest_tasks). You are told when",
      "it is connected, and take up your mission then."
    );
  if (improves.length === 0) return lines;
  lines.push(
    "",
    `**Accounts that make your work better:** ${improves.join(", ")}.`,
    "None is needed to start."
  );
  if (withoutAccounts != null)
    lines.push(`Until one is connected: ${withoutAccounts}`);
  if (required == null)
    lines.push(
      "Your first reply hands over a real result made without them, unless the",
      "job starts from something only the user can give (their question, a",
      "topic, a list): then ask for it in one short question. After that, you",
      "may offer one of them, the one that most improves what you handed over:",
      "call connect_connector for it and say in one line what it adds."
    );
  lines.push(
    "Otherwise ask for an account only when a request or a step needs it, one",
    "at a time, never several at once, and say in one line what it adds."
  );
  return lines;
};

/** What a check-in run does about accounts its mission names but the user has not connected. */
export const checkInAccountLine = (bot: Bot): string | null => {
  const { improves, withoutAccounts } = botAccounts(bot);
  if (improves.length === 0) return null;
  return [
    `Accounts that make this better: ${improves.join(", ")}.`,
    withoutAccounts == null
      ? "Do every part that works without the ones not connected."
      : `For the ones not connected: ${withoutAccounts}`,
    "Name a missing account at most once, in one line, with what it would add.",
  ].join(" ");
};

/** What a new bot was made from, as the bot_created detail. */
export const botCreatedDetail = (
  bot: Pick<Bot, "templateId" | "description">
): string =>
  bot.templateId != null
    ? funnelId(bot.templateId)
    : goalOfMission(bot.description) != null
      ? "own_words"
      : "custom";

/** "Europe/London time zone, United Kingdom"; null when neither is known. */
export const formatRegion = (
  timeZone: unknown,
  countryCode: unknown
): string | null => {
  let country: string | null = null;
  if (typeof countryCode === "string" && /^[A-Z]{2}$/.test(countryCode))
    try {
      country =
        new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) ??
        null;
    } catch {
      // An unknown code names nothing; the time zone still says where.
    }
  const zone =
    typeof timeZone === "string" && timeZone.length > 0
      ? `${timeZone} time zone`
      : null;
  const parts = [zone, country].filter((part): part is string => part != null);
  return parts.length === 0 ? null : parts.join(", ");
};

/** Where the computer says the user is, for weather, local news and times. */
export const regionLine = (region: string | null): string[] =>
  region == null
    ? []
    : [
        "",
        `**Where the user is:** this computer is set to ${region}. Use it for`,
        "weather, local news and local times unless the user names another place.",
      ];
