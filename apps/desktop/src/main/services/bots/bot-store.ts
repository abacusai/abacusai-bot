/**
 * The bot registry, `~/.abacusai-bot/bots.json`: plain fs with an atomic
 * tmp/rename write, since a half-written registry would orphan every bot's
 * chat. Each bot also owns `bots/<id>/`, removed with the record.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import {
  MAX_BOT_DESCRIPTION,
  MAX_BOT_PERSONA,
  MAX_BOT_NAME,
  MAX_BOT_TITLE,
  MAX_BOTS,
  defaultAvatarColor,
  defaultAvatarShape,
  type Bot,
  type BotCreateInput,
  type BotUpdateInput,
} from "#shared/bots";

import { abacusBotHome } from "../../paths";

const FILE = (): string => path.join(abacusBotHome(), "bots.json");

export const botDir = (botId: string): string =>
  path.join(abacusBotHome(), "bots", botId);

export const personaPath = (botId: string): string =>
  path.join(botDir(botId), "persona.md");

const read = (): Bot[] => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Bot & { connectorIds?: unknown }>).map((bot) => {
      // Old records still carry the field; dropped here so the next write
      // sheds it.
      const { connectorIds: _dropped, ...rest } = bot;
      return {
        ...rest,
        model: rest.model ?? null,
        persona: rest.persona ?? "",
        avatarShape: rest.avatarShape ?? defaultAvatarShape(rest.name),
      };
    });
  } catch {
    return [];
  }
};

const write = (bots: Bot[]): void => {
  writeFileAtomicSync(FILE(), `${JSON.stringify(bots, null, 2)}\n`);
};

let counter = 0;

export const listBots = (): Bot[] => read();

export const getBot = (id: string): Bot | null =>
  read().find((bot) => bot.id === id) ?? null;

export const createBot = (input: BotCreateInput): Bot => {
  const name = input.name.trim().slice(0, MAX_BOT_NAME);
  if (name.length === 0) throw new Error("A bot needs a name.");

  const description = input.description.trim().slice(0, MAX_BOT_DESCRIPTION);
  if (description.length === 0)
    throw new Error("A bot needs a description. It is the bot's mission.");

  const bots = read();
  if (bots.length >= MAX_BOTS)
    throw new Error(`At most ${MAX_BOTS} bots are supported.`);

  const bot: Bot = {
    id: `bot-${Date.now()}-${++counter}`,
    name,
    title: (input.title ?? "").trim().slice(0, MAX_BOT_TITLE),
    description,
    persona: (input.persona ?? "").trim().slice(0, MAX_BOT_PERSONA),
    avatarColor: input.avatarColor ?? defaultAvatarColor(name),
    channel: input.channel ?? null,
    avatarShape: input.avatarShape ?? defaultAvatarShape(name),
    workspaceId: input.workspaceId ?? null,
    sessionId: null,
    model: input.model ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  write([...bots, bot]);

  return bot;
};

export const updateBot = (id: string, changes: BotUpdateInput): Bot => {
  const bots = read();
  const index = bots.findIndex((bot) => bot.id === id);

  if (index < 0) throw new Error(`No bot with id "${id}".`);

  const merged: Bot = { ...bots[index], ...changes, updatedAt: Date.now() };
  merged.name = merged.name.trim().slice(0, MAX_BOT_NAME);
  merged.title = merged.title.trim().slice(0, MAX_BOT_TITLE);
  merged.description = merged.description.trim().slice(0, MAX_BOT_DESCRIPTION);
  merged.persona = (merged.persona ?? "").trim().slice(0, MAX_BOT_PERSONA);

  if (merged.name.length === 0) throw new Error("A bot needs a name.");
  if (merged.description.length === 0)
    throw new Error("A bot needs a description. It is the bot's mission.");

  bots[index] = merged;
  write(bots);

  return merged;
};

/** Record where the bot's forever chat lives (or that it no longer does). */
export const recordBotSession = (
  id: string,
  workspaceId: string | null,
  sessionId: string | null
): Bot | null => {
  const bots = read();
  const index = bots.findIndex((bot) => bot.id === id);

  if (index < 0) return null;

  bots[index] = { ...bots[index], workspaceId, sessionId };
  write(bots);

  return bots[index];
};

export const removeBot = (id: string): Bot => {
  const bots = read();
  const removed = bots.find((bot) => bot.id === id);

  if (removed == null) throw new Error(`No bot with id "${id}".`);

  write(bots.filter((bot) => bot.id !== id));

  try {
    fs.rmSync(botDir(id), { recursive: true, force: true });
  } catch {
    // The registry entry is gone either way; a leftover persona file is inert.
  }

  return removed;
};

/** The bot whose forever chat is this session, if any. */
export const botForSession = (sessionId: string): Bot | null => {
  const bots = read();
  const direct = bots.find((bot) => bot.sessionId === sessionId);
  if (direct != null) return direct;

  // Sender conversations run the same bot loop, so this lookup (which hands
  // the agent its ABACUSAI_BOT_BOT_DIR) has to cover them too.
  const botId = Object.entries(readSenderSessions()).find(
    ([, row]) => row.sessionId === sessionId
  )?.[1]?.botId;

  return botId != null ? (bots.find((bot) => bot.id === botId) ?? null) : null;
};

/**
 * Session ids owned by bots, which the Sessions list hides; sender
 * conversations included, since they live under their bot in the Bots pane.
 */
export const botSessionIds = (): string[] => [
  ...read()
    .map((bot) => bot.sessionId)
    .filter((id): id is string => id != null),
  ...Object.values(readSenderSessions()).map((row) => row.sessionId),
];

// ── Sender conversations ─────────────────────────────────────────────────

/**
 * `~/.abacusai-bot/bot-sender-sessions.json`: one conversation per (bot,
 * platform chat) that auto-reply answers; the gateway's routing table. One per
 * sender keeps the audience unambiguous: answering inbound messages in the
 * forever chat would flush notes meant for the user back to the sender.
 */
export type BotSenderSession = {
  botId: string;
  workspaceId: string;
  sessionId: string;
  platform: string;
  senderName: string;
};

const SENDER_FILE = (): string =>
  path.join(abacusBotHome(), "bot-sender-sessions.json");

const readSenderSessions = (): Record<string, BotSenderSession> => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(SENDER_FILE(), "utf8"));
    return parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, BotSenderSession>)
      : {};
  } catch {
    return {};
  }
};

const writeSenderSessions = (rows: Record<string, BotSenderSession>): void => {
  writeFileAtomicSync(SENDER_FILE(), JSON.stringify(rows, null, 2));
};

/** The route's identity: which chat, on which platform, for which bot. */
export const senderSessionKey = (
  botId: string,
  platform: string,
  chatId: string
): string => `${botId}|${platform}:${chatId}`;

export const getSenderSession = (key: string): BotSenderSession | null =>
  readSenderSessions()[key] ?? null;

export const listSenderSessions = (): BotSenderSession[] =>
  Object.values(readSenderSessions());

/** Rows with their keys; the owner backfill needs both. */
export const listSenderSessionEntries = (): Array<[string, BotSenderSession]> =>
  Object.entries(readSenderSessions());

export const recordSenderSession = (
  key: string,
  row: BotSenderSession
): void => {
  writeSenderSessions({ ...readSenderSessions(), [key]: row });
};

export const removeSenderSession = (key: string): void => {
  const rows = readSenderSessions();
  if (!(key in rows)) return;
  delete rows[key];
  writeSenderSessions(rows);
};

/** Drop a deleted bot's sender conversations from the routing table. */
export const removeSenderSessionsForBot = (botId: string): void => {
  const rows = readSenderSessions();
  const kept = Object.fromEntries(
    Object.entries(rows).filter(([, row]) => row.botId !== botId)
  );
  if (Object.keys(kept).length !== Object.keys(rows).length)
    writeSenderSessions(kept);
};
