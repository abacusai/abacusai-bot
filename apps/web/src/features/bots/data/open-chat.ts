import type { BotChatHandle } from "@abacus-ai/contract/bots";

/**
 * `openChatOnce` (spec 03 §5.3): `bots.openChat` at most once in flight per
 * bot per document. `openChat` has side effects (the forever session, the
 * agent start, the first-ever kickstart), so a resolved handle is reused
 * while the bot still points at that session and its row exists; a tab
 * change or a second navigation never calls it again.
 */
import type { Transport } from "#renderer/data/transport";

interface OpenChatDeps {
  transport: Pick<Transport, "client">;
  /** The session rows the cached handle must still find. */
  sessions: { has(id: string): boolean };
}

const inflight = new Map<string, Promise<BotChatHandle>>();
const resolved = new Map<string, BotChatHandle>();

/** The cached handle, when it is still valid for `bot`. */
export const cachedChat = (
  bot: { id: string; sessionId: string | null },
  sessions: { has(id: string): boolean }
): BotChatHandle | null => {
  const handle = resolved.get(bot.id);
  if (handle == null) return null;
  if (bot.sessionId !== handle.sessionId || !sessions.has(handle.sessionId))
    return null;
  return handle;
};

export const openChatOnce = (
  { transport, sessions }: OpenChatDeps,
  bot: { id: string; sessionId: string | null }
): Promise<BotChatHandle> => {
  const cached = cachedChat(bot, sessions);
  if (cached != null) return Promise.resolve(cached);
  const pending = inflight.get(bot.id);
  if (pending != null) return pending;
  const request = transport.client.bots
    .openChat({ botId: bot.id })
    .then((handle) => {
      resolved.set(bot.id, handle);
      return handle;
    })
    .finally(() => {
      inflight.delete(bot.id);
    });
  inflight.set(bot.id, request);
  return request;
};

/** Retry, delete: the next open asks main again. */
export const forgetOpenChat = (botId: string): void => {
  resolved.delete(botId);
  inflight.delete(botId);
};

/** Tests only. */
export const resetOpenChats = (): void => {
  resolved.clear();
  inflight.clear();
};
