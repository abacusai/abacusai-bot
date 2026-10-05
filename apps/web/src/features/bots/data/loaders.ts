import { notFound } from "@tanstack/react-router";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";
import { findCheckIn } from "#renderer/lib/bots/check-in";

import { cachedChat, openChatOnce } from "./open-chat";

interface ChatLoadDeps {
  db: Db;
  load(id: string): Promise<unknown>;
  /** A hover: fetch the transcript's first page, create no session. */
  warm(id: string): void;
  /** The runtime already holds this chat ready: nothing left to load. */
  ready(id: string): boolean;
}
export const loadBot = async (db: Db, botId: string) => {
  await db.collections.bots.preload();
  const bot = db.collections.bots.get(botId);
  if (!bot) throw notFound();
  return bot;
};
export const loadBotChat = async (
  deps: ChatLoadDeps & { transport: Transport },
  botId: string,
  preload: boolean
) => {
  await Promise.all([
    deps.db.collections.bots.preload(),
    deps.db.collections.sessions.preload(),
  ]);
  const bot = await loadBot(deps.db, botId);
  if (preload) {
    // Only a chat this document already opened: `bots.openChat` has side
    // effects and waits for the click.
    const cached = cachedChat(bot, deps.db.collections.sessions);
    // A ready chat commits as the page itself: the click, which reuses this
    // stale preload while it reloads in the background, shows the chat
    // instead of the skeleton.
    if (cached != null && deps.ready(cached.sessionId))
      return {
        ready: true as const,
        botId,
        sessionId: cached.sessionId,
        workspaceId: cached.workspaceId,
      };
    if (cached != null) deps.warm(cached.sessionId);
    return { ready: false as const, botId };
  }
  const handle = await openChatOnce(
    { transport: deps.transport, sessions: deps.db.collections.sessions },
    bot
  );
  await deps.load(handle.sessionId);
  return {
    ready: true as const,
    botId,
    sessionId: handle.sessionId,
    workspaceId: handle.workspaceId,
  };
};
export const loadSenderChat = async (
  deps: ChatLoadDeps,
  botId: string,
  sessionId: string,
  preload: boolean
) => {
  await Promise.all([
    deps.db.collections.bots.preload(),
    deps.db.collections.sessions.preload(),
    deps.db.collections.routines.preload(),
  ]);
  await loadBot(deps.db, botId);
  const session = deps.db.collections.sessions.get(sessionId);
  const routine = findCheckIn(deps.db.collections.routines.toArray, botId);
  if (
    !session ||
    !(
      (session.owner?.kind === "bot" &&
        session.owner.botId === botId &&
        session.owner.role !== "forever") ||
      (routine && session.routineId === routine.id)
    )
  )
    throw notFound();
  if (preload) {
    if (deps.ready(sessionId)) return { ready: true as const, sessionId };
    deps.warm(sessionId);
    return { ready: false as const };
  }
  await deps.load(sessionId);
  return { ready: true as const, sessionId };
};
