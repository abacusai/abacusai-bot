import type {
  ArtifactRow,
  BotRow,
  MemoryRow,
  RoutineRow,
  SessionRow,
} from "@abacus-ai/contract/contract/rows";
/**
 * What the bots area reads (spec 03 §6.1, §6.2): query options over the
 * transport, and live queries over the DB collections. The live queries
 * filter and join in the query, nested fields (`owner.botId`) included, so
 * a component re-renders only when its rows change.
 */
import {
  and,
  eq,
  isUndefined,
  not,
  or,
  type InitialQueryBuilder,
} from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";

import { useCollections, type Collections } from "#renderer/data/db";
import { useCollectionStatus } from "#renderer/data/db/status";
import type { AppQueryUtils } from "#renderer/data/transport";
import { isCheckInRoutine } from "#renderer/lib/bots/check-in";

/** Query options, keyed off the transport's oRPC utils (§6.1). */
export const botsQueries = (orpc: AppQueryUtils) => ({
  chatPreviews: () => orpc.bots.chatPreviews.queryOptions({ input: {} }),
  senderChats: () => orpc.bots.senderChats.queryOptions({ input: {} }),
  memoryBots: () => orpc.memory.bots.queryOptions({ input: {} }),
  // The host builds the catalog from provider APIs (hundreds of ms) and it
  // changes only with credentials or providers, whose changes invalidate it
  // (the settings notice follower, the models page): fresh for five minutes.
  // Inline: a shared helper module would split into a chunk of its own.
  models: () =>
    orpc.models.list.queryOptions({ input: {}, staleTime: 5 * 60_000 }),
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

/**
 * The bot's check-in as a subquery: its oldest routine with the exact
 * check-in prompt (`isCheckInRoutine`, the one definition `findCheckIn`
 * uses too).
 */
const checkInOf = (
  q: InitialQueryBuilder,
  collections: Collections,
  botId: string
) =>
  q
    .from({ r: collections.routines })
    .fn.where(({ r }) => isCheckInRoutine(r, botId))
    .orderBy(({ r }) => r.createdAt, "asc")
    .limit(1);

/**
 * The bot's sessions as a subquery (§6.2): forever and sender sessions by
 * `owner.botId`, check-in runs by `routineId` (main mints them with
 * `owner: null`), joined to the check-in so a new check-in or session
 * changes the rows, not the query.
 */
const botSessionsOf$ = (
  q: InitialQueryBuilder,
  collections: Collections,
  botId: string
) =>
  q
    .from({ s: collections.sessions })
    .leftJoin({ c: checkInOf(q, collections, botId) }, ({ s, c }) =>
      eq(s.routineId, c.id)
    )
    .where(({ s, c }) => or(eq(s.owner?.botId, botId), not(isUndefined(c?.id))))
    .select(({ s }) => ({ ...s }));

// The live queries below are keyed by the bot alone: their identity, and so
// their collection, changes only when the bot does.

export const useCheckIn = (botId: string): RoutineRow | null => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    queryKey: ["bots", "checkIn", botId],
    query: (q) => checkInOf(q, collections, botId).findOne(),
  });
  return data ?? null;
};

/** `botSessionsOf` as a live query: oldest first. */
export const useBotSessions = (botId: string): SessionRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    queryKey: ["bots", "sessions", botId],
    query: (q) =>
      q
        .from({ s: botSessionsOf$(q, collections, botId) })
        .orderBy(({ s }) => s.createdAt, "asc"),
  });
  return (data ?? []) as SessionRow[];
};

export const useBotMemories = (botId: string): MemoryRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ m: collections.memories })
        .where(({ m }) => and(eq(m.botId, botId), eq(m.scope, "bot")))
        .orderBy(({ m }) => m.index, "asc"),
  });
  return data ?? [];
};

/**
 * The files of the bot's sessions, newest first: a join on the session id,
 * so membership is a keyed lookup, not a scan of the id list.
 */
export const useBotFiles = (botId: string): ArtifactRow[] => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    queryKey: ["bots", "files", botId],
    query: (q) =>
      q
        .from({ a: collections.artifacts })
        .innerJoin({ s: botSessionsOf$(q, collections, botId) }, ({ a, s }) =>
          eq(a.sessionId, s.id)
        )
        .orderBy(({ a }) => a.updatedAt, "desc")
        .select(({ a }) => ({ ...a })),
  });
  return (data ?? []) as ArtifactRow[];
};
