/**
 * The bot registry, `~/.abacusai-bot/bots.json`: plain fs with an atomic
 * tmp/rename write, since a half-written registry would orphan every bot's
 * chat. Each bot also owns `bots/<id>/`, removed with the record.
 */
import fs from "fs";
import path from "path";

import {
  recoverFromBackupSync,
  writeFileAtomicSync,
} from "@abacus-ai/agent/atomic-file";
import {
  MAX_BOT_DESCRIPTION,
  MAX_BOT_PERSONA,
  MAX_BOT_NAME,
  MAX_BOT_TITLE,
  MAX_BOTS,
  SPONSORED_FIRST_RUN_WINDOW_MS,
  defaultAvatarColor,
  defaultAvatarShape,
  type Bot,
  type BotCreateInput,
  type BotUpdateInput,
} from "@abacus-ai/contract/bots";
import { ConflictError } from "@abacus-ai/contract/conflict";
import { EntityNotFoundError } from "@abacus-ai/contract/not-found";
import {
  InvalidInputError,
  PreconditionError,
} from "@abacus-ai/contract/service-errors";

import { abacusBotHome } from "../../paths";

const FILE = (): string => path.join(abacusBotHome(), "bots.json");

export const botDir = (botId: string): string =>
  path.join(abacusBotHome(), "bots", botId);

export const personaPath = (botId: string): string =>
  path.join(botDir(botId), "persona.md");

/** The array `text` holds, or null when it is not one. */
const parseRecords = (text: string): unknown[] | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * The stored array, or null when the file is there but unreadable. Bytes
 * that do not parse (a crash can leave them NUL-filled) are put back from
 * the last good copy first.
 */
const readRecords = (): unknown[] | null => {
  let text: string;
  try {
    text = fs.readFileSync(FILE(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  const records = parseRecords(text);
  if (records !== null) return records;
  const restored = recoverFromBackupSync(
    FILE(),
    (backup) => parseRecords(backup) !== null
  );
  if (restored === null) return null;
  console.warn(
    "[bot-store] bots.json did not parse; restored it from its last good copy"
  );
  return parseRecords(restored);
};

const isBotRecord = (
  record: unknown
): record is Bot & { connectorIds?: unknown } =>
  record != null &&
  typeof record === "object" &&
  typeof (record as Bot).id === "string" &&
  typeof (record as Bot).name === "string";

// Mutations read raw accessories so unrelated edits do not backfill old rows.
const read = (normalizeAccessory = true): Bot[] =>
  (readRecords() ?? []).filter(isBotRecord).map((bot) => {
    // Old records still carry the field; dropped here so the next write
    // sheds it.
    const { connectorIds: _dropped, ...rest } = bot;
    return {
      ...rest,
      ...(normalizeAccessory
        ? { avatarAccessory: rest.avatarAccessory ?? "none" }
        : {}),
      title: rest.title ?? "",
      model: rest.model ?? null,
      persona: rest.persona ?? "",
      sponsoredUntil: rest.sponsoredUntil ?? null,
      // Bots from before the flag: a chat that exists was kicked off.
      kickstartedAt:
        rest.kickstartedAt ??
        (rest.sessionId != null ? (rest.createdAt ?? Date.now()) : null),
      avatarColor: rest.avatarColor ?? defaultAvatarColor(rest.name),
      avatarShape: rest.avatarShape ?? defaultAvatarShape(rest.name),
    };
  });

const writeListeners = new Set<() => void>();

/**
 * Called after every write of `bots.json`, whoever made it: the DB table's
 * direct hook (spec 00 B.2), so a write that emits no event is still seen.
 */
export const onBotStoreWrite = (listener: () => void): (() => void) => {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
};

// Records this version cannot read are written back as they were.
const write = (bots: Bot[]): void => {
  const records = readRecords();
  if (records == null)
    throw new Error("bots.json could not be read, so it was not changed.");
  const kept = records.filter((record) => !isBotRecord(record));
  writeFileAtomicSync(
    FILE(),
    `${JSON.stringify([...bots, ...kept], null, 2)}\n`,
    { keepBackup: true }
  );
  for (const listener of Array.from(writeListeners)) {
    try {
      listener();
    } catch (error) {
      console.error("[bot-store] write listener threw", error);
    }
  }
};

let counter = 0;

export const listBots = (): Bot[] => read();

export const getBot = (id: string): Bot | null =>
  read().find((bot) => bot.id === id) ?? null;

/** `id`: the caller's own (an optimistic insert); a taken one is refused. */
export const createBot = (input: BotCreateInput, id?: string): Bot => {
  const name = input.name.trim().slice(0, MAX_BOT_NAME);
  if (name.length === 0) throw new InvalidInputError("A bot needs a name.");

  const description = input.description.trim().slice(0, MAX_BOT_DESCRIPTION);
  if (description.length === 0)
    throw new InvalidInputError(
      "A bot needs a description. It is the bot's mission."
    );

  const bots = read(false);
  if (bots.length >= MAX_BOTS)
    throw new PreconditionError(
      "bot-limit",
      `At most ${MAX_BOTS} bots are supported.`
    );
  if (id != null && bots.some((bot) => bot.id === id))
    throw new ConflictError(`A bot with id "${id}" already exists.`);

  const taken = new Set(bots.map((bot) => bot.id));
  let generated = `bot-${Date.now()}-${++counter}`;
  // A caller id may look like a minted one (same clock, same counter).
  while (id == null && taken.has(generated))
    generated = `bot-${Date.now()}-${++counter}`;

  const bot: Bot = {
    id: id ?? generated,
    name,
    title: (input.title ?? "").trim().slice(0, MAX_BOT_TITLE),
    description,
    persona: (input.persona ?? "").trim().slice(0, MAX_BOT_PERSONA),
    avatarColor: input.avatarColor ?? defaultAvatarColor(name),
    channel: input.channel ?? null,
    ...(input.homeChannel != null ? { homeChannel: input.homeChannel } : {}),
    ...(input.templateId != null ? { templateId: input.templateId } : {}),
    avatarShape: input.avatarShape ?? defaultAvatarShape(name),
    ...(input.avatarAccessory !== undefined
      ? { avatarAccessory: input.avatarAccessory }
      : {}),
    workspaceId: input.workspaceId ?? null,
    sessionId: null,
    model: input.model ?? null,
    sponsoredUntil:
      input.sponsoredFirstRun === true
        ? Date.now() + SPONSORED_FIRST_RUN_WINDOW_MS
        : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  write([...bots, bot]);

  return { ...bot, avatarAccessory: bot.avatarAccessory ?? "none" };
};

export const updateBot = (id: string, changes: BotUpdateInput): Bot => {
  const bots = read(false);
  const index = bots.findIndex((bot) => bot.id === id);

  if (index < 0)
    throw new EntityNotFoundError("bot", id, `No bot with id "${id}".`);

  const merged: Bot = { ...bots[index], ...changes, updatedAt: Date.now() };
  merged.name = merged.name.trim().slice(0, MAX_BOT_NAME);
  merged.title = merged.title.trim().slice(0, MAX_BOT_TITLE);
  merged.description = merged.description.trim().slice(0, MAX_BOT_DESCRIPTION);
  merged.persona = (merged.persona ?? "").trim().slice(0, MAX_BOT_PERSONA);

  if (merged.name.length === 0)
    throw new InvalidInputError("A bot needs a name.");
  if (merged.description.length === 0)
    throw new InvalidInputError(
      "A bot needs a description. It is the bot's mission."
    );

  bots[index] = merged;
  write(bots);

  return { ...merged, avatarAccessory: merged.avatarAccessory ?? "none" };
};

/** Record where the bot's forever chat lives (or that it no longer does). */
/** The bot has been told to speak first in its chat. */
export const markBotKickstarted = (id: string): void => {
  const bots = read();
  const index = bots.findIndex((bot) => bot.id === id);
  if (index < 0) return;
  bots[index] = { ...bots[index], kickstartedAt: Date.now() };
  write(bots);
};

export const recordBotSession = (
  id: string,
  workspaceId: string | null,
  sessionId: string | null
): Bot | null => {
  const bots = read(false);
  const index = bots.findIndex((bot) => bot.id === id);

  if (index < 0) return null;

  bots[index] = { ...bots[index], workspaceId, sessionId };
  write(bots);

  return {
    ...bots[index],
    avatarAccessory: bots[index].avatarAccessory ?? "none",
  };
};

export const removeBot = (id: string): Bot => {
  const bots = read(false);
  const removed = bots.find((bot) => bot.id === id);

  if (removed == null)
    throw new EntityNotFoundError("bot", id, `No bot with id "${id}".`);

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
