/**
 * Every bots mutation (spec 03 §6.4): the collection write, what the caller
 * awaits, and each failure's handling. Errors are branched on their typed
 * `code`/`data` only, never on message text (§6.5, R3-T11).
 */
import { DeleteKeyNotFoundError } from "@tanstack/db";

import type { Collections, Db } from "#next/data/db";
import type { Transport } from "#next/data/transport";
import { MAX_BOT_NAME, MAX_BOTS, type BotChangeNotice } from "#shared/bots";
import type { BotRow, MemoryRow, RoutineRow } from "#shared/contract/rows";

import { forgetOpenChat } from "./open-chat";
import { botsUnreadStore } from "./unread-store";

type BotsCollection = Collections["bots"];

export const codeOf = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

export const dataOf = (error: unknown): Record<string, unknown> | null => {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === "object" && data !== null
    ? (data as Record<string, unknown>)
    : null;
};

/** What a failed create/save tells the form (§6.4). */
export type BotSaveError =
  | { kind: "limit" }
  | { kind: "conflict" }
  | { kind: "not-found" }
  | { kind: "bad-request"; field: string | null }
  | { kind: "other"; detail: string | null };

export const saveErrorOf = (error: unknown): BotSaveError => {
  const code = codeOf(error);
  const data = dataOf(error);
  if (code === "PRECONDITION_FAILED" && data?.reason === "bot-limit")
    return { kind: "limit" };
  if (code === "CONFLICT") return { kind: "conflict" };
  if (code === "NOT_FOUND") return { kind: "not-found" };
  if (code === "BAD_REQUEST")
    return {
      kind: "bad-request",
      field: typeof data?.field === "string" ? data.field : null,
    };
  return {
    kind: "other",
    detail:
      error instanceof Error && error.message !== "" ? error.message : null,
  };
};

export const newBotId = (): string => `bot-${crypto.randomUUID()}`;
export const newRoutineId = (): string => `routine-${crypto.randomUUID()}`;

/**
 * Create (§6.4 row 1): the optimistic row, awaited until main's echo is in.
 * A taken id (`CONFLICT`) retries once with a fresh id. Resolves to the id
 * the bot was created with.
 */
export const createBot = async (
  bots: Pick<BotsCollection, "insert">,
  row: BotRow,
  mintId: () => string = newBotId
): Promise<string> => {
  try {
    await bots.insert(row).isPersisted.promise;
    return row.id;
  } catch (error) {
    if (codeOf(error) !== "CONFLICT") throw error;
    const retry = { ...row, id: mintId() };
    await bots.insert(retry).isPersisted.promise;
    return retry.id;
  }
};

/**
 * Update with only the fields the user edited (§6.4 Concurrency). An empty
 * patch, or one equal to the row, sends nothing.
 */
export const updateBot = async (
  bots: Pick<BotsCollection, "update" | "get">,
  id: string,
  patch: Partial<BotRow>
): Promise<void> => {
  const current = bots.get(id);
  if (current == null)
    throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
  const changed = Object.entries(patch).filter(
    ([key, value]) =>
      (current as unknown as Record<string, unknown>)[key] !== value
  );
  if (changed.length === 0) return;
  const tx = bots.update(id, (draft) => {
    for (const [key, value] of changed)
      (draft as unknown as Record<string, unknown>)[key] = value;
  });
  await tx.isPersisted.promise;
};

/** The model (Details, chip, editor): only the row (§13.4; main re-pins). */
export const setBotModel = (
  bots: Pick<BotsCollection, "update" | "get">,
  id: string,
  model: string | null
): Promise<void> => updateBot(bots, id, { model });

/**
 * Delete (§5.5, §6.4): navigate away first, then delete, so no frame renders
 * a null bot. A row already gone (another window, main) counts as deleted.
 */
export const deleteBot = async (
  deps: {
    bots: Pick<BotsCollection, "delete">;
    /** Moves the pane off the bot before the row disappears. */
    leave?: () => Promise<void> | void;
  },
  id: string
): Promise<void> => {
  await deps.leave?.();
  forgetOpenChat(id);
  botsUnreadStore.clear(id);
  try {
    await deps.bots.delete(id).isPersisted.promise;
  } catch (error) {
    if (error instanceof DeleteKeyNotFoundError) return;
    throw error;
  }
};

/** Pin/unpin: a prefs patch (the explicit choice is recorded as the user's). */
export const setPinned = (
  db: Pick<Db, "updatePrefs">,
  pinnedIds: readonly string[],
  botId: string,
  pinned: boolean
): Promise<void> => {
  const next = pinned
    ? [...pinnedIds.filter((id) => id !== botId), botId]
    : pinnedIds.filter((id) => id !== botId);
  return db.updatePrefs({ pinned: { botIds: next } });
};

/** "Name 2", "Name 3", …, within the 30-character limit (§6.4 Duplicate). */
export const duplicateName = (
  name: string,
  taken: ReadonlySet<string>
): string => {
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const base = name.slice(0, MAX_BOT_NAME - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export const duplicateBot = async (
  bots: Pick<BotsCollection, "insert">,
  source: BotRow,
  all: readonly BotRow[],
  now: number = Date.now()
): Promise<string | null> => {
  if (all.length >= MAX_BOTS) return null;
  const row: BotRow = {
    ...source,
    id: newBotId(),
    name: duplicateName(source.name, new Set(all.map((bot) => bot.name))),
    sessionId: null,
    channel: null,
    createdAt: now,
    updatedAt: now,
  };
  return createBot(bots, row);
};

/** Pause/resume check-ins: `enabled` alone. */
export const setCheckInsEnabled = async (
  routines: Pick<Collections["routines"], "update">,
  routine: Pick<RoutineRow, "id">,
  enabled: boolean
): Promise<void> => {
  await routines.update(routine.id, (draft) => {
    draft.enabled = enabled;
  }).isPersisted.promise;
};

/**
 * Forget one memory: the original row goes to main, so a stale click is
 * `CONFLICT` (rolled back; the caller toasts) rather than another entry's
 * removal.
 */
export const forgetMemory = async (
  memories: Pick<Collections["memories"], "delete">,
  row: Pick<MemoryRow, "id">
): Promise<"forgotten" | "stale"> => {
  try {
    await memories.delete(row.id).isPersisted.promise;
    return "forgotten";
  } catch (error) {
    if (error instanceof DeleteKeyNotFoundError) return "forgotten";
    if (codeOf(error) === "CONFLICT") return "stale";
    throw error;
  }
};

export const clearMemory = (
  transport: Pick<Transport, "client">,
  botId: string
): Promise<unknown> => transport.client.memory.clearBot({ botId });

/** Fire and forget (parity: errors logged, never shown). */
export const announceChange = (
  transport: Pick<Transport, "client">,
  id: string,
  notice: BotChangeNotice
): void => {
  if (
    notice.mission !== true &&
    notice.persona !== true &&
    notice.checkIn == null
  )
    return;
  void transport.client.bots.announceChange({ id, notice }).catch((error) => {
    console.warn("[bots] announceChange failed", error);
  });
};

export const decideSenderPairing = (
  transport: Pick<Transport, "client">,
  input: {
    platformId: string;
    userId: string;
    decision: "pause" | "resume";
  }
): Promise<unknown> => transport.client.messaging.decidePairing(input as never);
