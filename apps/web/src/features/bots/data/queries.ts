/**
 * What the bots area reads (spec 03 §6.1, §6.2): query options over the
 * transport, and live queries over the DB collections. Filters on nested
 * fields (`owner.botId`) run in the component over the whole table, which
 * holds a few hundred rows; R3-T6 pins that form.
 */
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";

import { useCollections } from "#renderer/data/db";
import { useCollectionStatus } from "#renderer/data/db/status";
import type { AppQueryUtils } from "#renderer/data/transport";
import { findCheckIn } from "#renderer/lib/bots/check-in";
import type {
  ArtifactRow,
  BotRow,
  MemoryRow,
  RoutineRow,
  SessionRow,
} from "@abacus-ai/contract/contract/rows";

/** Query options, keyed off the transport's oRPC utils (§6.1). */
export const botsQueries = (orpc: AppQueryUtils) => ({
  chatPreviews: () => orpc.bots.chatPreviews.queryOptions({ input: {} }),
  senderChats: () => orpc.bots.senderChats.queryOptions({ input: {} }),
  memoryBots: () => orpc.memory.bots.queryOptions({ input: {} }),
  models: () => orpc.models.list.queryOptions({ input: {} }),
  settings: () => orpc.settings.get.queryOptions({ input: {} }),
  providers: () => orpc.settings.keys.listProviders.queryOptions({ input: {} }),
  defaultMode: () => orpc.settings.defaultMode.get.queryOptions({ input: {} }),
  messaging: () => orpc.messaging.snapshot.queryOptions({ input: {} }),
  connectorStatuses: () => orpc.connectors.statuses.queryOptions({ input: {} }),
  account: () => orpc.account.abacus.queryOptions({ input: {} }),
});

/** Every bot, newest first, and the table's load state. */
export const useBots = (): {
  bots: BotRow[];
  status: ReturnType<typeof useCollectionStatus>;
  retry(): void;
} => {
  const collections = useCollections();
  const { data } = useLiveQuery((q) =>
    q.from({ b: collections.bots }).orderBy(({ b }) => b.updatedAt, "desc")
  );
  const status = useCollectionStatus(collections.bots);
  return {
    bots: data ?? [],
    status,
    retry: () => void collections.bots.utils.resync().catch(() => undefined),
  };
};

export const useBot = (botId: string): BotRow | undefined => {
  const collections = useCollections();
  const { data } = useLiveQuery(
    (q) =>
      q
        .from({ b: collections.bots })
        .where(({ b }) => eq(b.id, botId))
        .findOne(),
    [botId]
  );
  return data;
};

export const useAllSessions = (): SessionRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery((q) => q.from({ s: collections.sessions }));
  return data ?? [];
};

export const useAllRoutines = (): RoutineRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery((q) => q.from({ r: collections.routines }));
  return data ?? [];
};

/**
 * A bot's sessions (§6.2): forever and sender sessions by `owner.botId`,
 * check-in runs by `routineId` (main mints them with `owner: null`).
 */
export const botSessionsOf = (
  sessions: readonly SessionRow[],
  botId: string,
  checkInId: string | null
): SessionRow[] =>
  sessions
    .filter(
      (session) =>
        session.owner?.botId === botId ||
        (checkInId != null && session.routineId === checkInId)
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));

export const useCheckIn = (botId: string): RoutineRow | null =>
  findCheckIn(useAllRoutines(), botId);

export const useBotSessions = (botId: string): SessionRow[] => {
  const sessions = useAllSessions();
  const checkIn = useCheckIn(botId);
  return botSessionsOf(sessions, botId, checkIn?.id ?? null);
};

export const useBotMemories = (botId: string): MemoryRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery(
    (q) =>
      q
        .from({ m: collections.memories })
        .where(({ m }) => eq(m.botId, botId))
        .orderBy(({ m }) => m.index, "asc"),
    [botId]
  );
  return (data ?? []).filter((row) => row.scope === "bot");
};

export const useBotFiles = (sessionIds: readonly string[]): ArtifactRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery((q) =>
    q.from({ a: collections.artifacts }).orderBy(({ a }) => a.updatedAt, "desc")
  );
  const ids = new Set(sessionIds);
  return (data ?? []).filter((row) => ids.has(row.sessionId));
};
