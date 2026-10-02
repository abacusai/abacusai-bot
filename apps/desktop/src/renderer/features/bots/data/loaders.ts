import { notFound } from "@tanstack/react-router";

import type { Db } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";
import { findCheckIn } from "#renderer/lib/bots/check-in";

import { openChatOnce } from "./open-chat";
export const loadBot = async (db: Db, botId: string) => {
  await db.collections.bots.preload();
  const bot = db.collections.bots.get(botId);
  if (!bot) throw notFound();
  return bot;
};
export const loadBotChat = async (
  deps: { db: Db; transport: Transport; load(id: string): Promise<unknown> },
  botId: string,
  preload: boolean
) => {
  await Promise.all([
    deps.db.collections.bots.preload(),
    deps.db.collections.sessions.preload(),
  ]);
  const bot = await loadBot(deps.db, botId);
  if (preload) return { ready: false as const, botId };
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
  deps: { db: Db; load(id: string): Promise<unknown> },
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
  if (preload) return { ready: false as const };
  await deps.load(sessionId);
  return { ready: true as const, sessionId };
};
