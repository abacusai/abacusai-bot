import type {
  ArtifactRow,
  BotRow,
  GitStateRow,
  MemoryRow,
  PrefsGroup,
  PrefsPatch,
  PrefsRow,
  RoutineRow,
  RoutineRunRow,
  SessionRow,
  WorkspaceRow,
} from "@abacus-ai/contract/contract/rows";
/**
 * One set of collection options per `db.*` table (spec 00 B.2, B.3): the key,
 * what each mutation sends, and whether the shell needs the table at once.
 * Each takes a lazy transport, so tests pass an in-memory one and the app
 * passes `getTransport`.
 */
import { createTransaction } from "@tanstack/db";

import type { Transport } from "../transport/types";
import {
  ipcCollectionOptions,
  type IpcCollectionUtils,
  type IpcCollectionConfig,
  type IpcCollectionOptions,
  type IpcTableClient,
} from "./ipc-collection-options";

export type LazyTransport = () => Promise<Transport>;

type Db = Transport["client"]["db"];

/** Extra knobs a caller (a test) may set on any table. */
export type TableOverrides = Pick<
  IpcCollectionConfig<object, string>,
  "echoTimeoutMs" | "retryDelayMs" | "startSync" | "signal"
>;

/**
 * bots and routines never garbage-collect: they are small, every area reads
 * them, and main does no work for an idle subscription. Dropping them 5
 * minutes after the last reader made the next loader pay a fresh changes +
 * snapshot. The other lazy tables keep TanStack DB's default: while
 * subscribed, main polls artifacts, fingerprints git for gitState and
 * watches the memory directories.
 */
const PERMANENT = Infinity;

const tableOf =
  <Row, Key extends string>(
    transport: LazyTransport,
    pick: (db: Db) => IpcTableClient<Row, Key>
  ): (() => Promise<IpcTableClient<Row, Key>>) =>
  async () =>
    pick((await transport()).client.db);

/** Only the fields a patch may carry, and only those that changed. */
const pickDefined = <T extends object, K extends keyof T>(
  source: Partial<T>,
  keys: readonly K[]
): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
};

/**
 * A collection update that touched a field main does not let the client
 * write (B.2 "read-only field"). Thrown from the handler, so the optimistic
 * change rolls back and the caller sees the refusal instead of a silent
 * success that reverts.
 */
export class ReadOnlyFieldError extends Error {
  readonly code = "FORBIDDEN";
  constructor(
    readonly table: string,
    readonly fields: string[]
  ) {
    super(`${table}: read-only field: ${fields.join(", ")}`);
    this.name = "ReadOnlyFieldError";
  }
}

/** The changed keys, refusing any outside `writable`. */
const writablePatch = <T extends object, K extends keyof T>(
  table: string,
  changes: Partial<T>,
  writable: readonly (keyof T)[],
  keep: readonly K[]
): Partial<Pick<T, K>> => {
  const refused = Object.keys(changes).filter(
    (key) => !writable.includes(key as keyof T)
  );
  if (refused.length > 0) throw new ReadOnlyFieldError(table, refused);
  return pickDefined(changes, keep);
};

const byId = <Row extends { id: string }>(row: Row): string => row.id;

const SESSION_WRITABLE = ["label", "model"] as const;

export const sessionsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<SessionRow, string> =>
  ipcCollectionOptions<SessionRow, string>({
    id: "sessions",
    table: tableOf(transport, (db) => db.sessions),
    getKey: byId,
    // The shell's sidebar needs it before anything renders.
    startSync: true,
    toInsertInput: (row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      model: row.model,
      mode: row.mode,
    }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: writablePatch(
        "sessions",
        changes,
        SESSION_WRITABLE,
        SESSION_WRITABLE
      ),
    }),
    toDeleteInput: (id) => ({ id }),
    ...overrides,
  });

const BOT_CREATE_FIELDS = [
  "sponsoredFirstRun",
  "name",
  "title",
  "description",
  "persona",
  "avatarColor",
  "avatarShape",
  "avatarAccessory",
  "wallpaper",
  "workspaceId",
  "model",
  "channel",
] as const;

const BOT_UPDATE_FIELDS = [
  "name",
  "title",
  "description",
  "persona",
  "avatarColor",
  "avatarShape",
  "avatarAccessory",
  "wallpaper",
  "model",
  "channel",
] as const;

export const botsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<BotRow, string> =>
  ipcCollectionOptions<BotRow, string>({
    id: "bots",
    gcTime: PERMANENT,
    table: tableOf(transport, (db) => db.bots),
    getKey: byId,
    toInsertInput: (row) => ({
      ...pickDefined(row, BOT_CREATE_FIELDS),
      id: row.id,
    }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: writablePatch(
        "bots",
        changes,
        BOT_UPDATE_FIELDS,
        BOT_UPDATE_FIELDS
      ),
    }),
    toDeleteInput: (id) => ({ id }),
    idempotentDelete: true,
    ...overrides,
  });

const ROUTINE_UPDATE_FIELDS = [
  "schedule",
  "runAt",
  "prompt",
  "enabled",
  "name",
  "botId",
  "workspaceId",
  "access",
  "reach",
] as const;

export const routinesCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<RoutineRow, string> =>
  ipcCollectionOptions<RoutineRow, string>({
    id: "routines",
    gcTime: PERMANENT,
    table: tableOf(transport, (db) => db.routines),
    getKey: byId,
    toInsertInput: (row) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      runAt: row.runAt,
      // An optimistic row asks for a webhook by carrying any token; main
      // mints the real one.
      webhook: row.webhookToken != null,
      prompt: row.prompt,
      workspaceId: row.workspaceId,
      botId: row.botId,
      // Only a row that chose a runner says so; the rest take main's default.
      ...(row.runner != null ? { runner: row.runner } : {}),
      ...(row.hosted?.timezone != null
        ? { timezone: row.hosted.timezone }
        : {}),
      // What its runs may read, as the user set it in the form.
      ...((row.hosted ?? row.reach) != null
        ? {
            sources: (row.hosted ?? row.reach)!.sources,
            reads: (row.hosted ?? row.reach)!.reads,
          }
        : {}),
    }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: {
        ...writablePatch(
          "routines",
          changes,
          [...ROUTINE_UPDATE_FIELDS, "webhookToken"],
          ROUTINE_UPDATE_FIELDS
        ),
        ...(changes.webhookToken !== undefined
          ? { webhook: changes.webhookToken != null }
          : {}),
      },
    }),
    toDeleteInput: (id) => ({ id }),
    idempotentDelete: true,
    ...overrides,
  });

/** Derived from sessions in main; read-only. */
export const routineRunsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<RoutineRunRow, string> =>
  ipcCollectionOptions<RoutineRunRow, string>({
    id: "routineRuns",
    table: tableOf(transport, (db) => db.routineRuns),
    getKey: (row) => row.sessionId,
    ...overrides,
  });

/** Read-only: removed with their session. */
export const artifactsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<ArtifactRow, string> =>
  ipcCollectionOptions<ArtifactRow, string>({
    id: "artifacts",
    table: tableOf(transport, (db) => db.artifacts),
    getKey: byId,
    ...overrides,
  });

/**
 * Delete only. The input is the row the user clicked (`mutation.original`),
 * so main can refuse a click made stale by renumbering or a duplicate.
 */
export const memoriesCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<MemoryRow, string> =>
  ipcCollectionOptions<MemoryRow, string>({
    id: "memories",
    table: tableOf(transport, (db) => db.memories),
    getKey: byId,
    toDeleteInput: (_id, original) => ({
      id: original.id,
      scope: original.scope,
      target: original.target,
      botId: original.botId,
      index: original.index,
      entry: original.entry,
      occurrences: original.occurrences,
    }),
    ...overrides,
  });

/** No insert: `workspaces.add` derives the id from the path. */
export const workspacesCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<WorkspaceRow, string> =>
  ipcCollectionOptions<WorkspaceRow, string>({
    id: "workspaces",
    table: tableOf(transport, (db) => db.workspaces),
    getKey: byId,
    startSync: true,
    toUpdateInput: (id, changes, modified) => {
      writablePatch("workspaces", changes, ["label"], []);
      return { id, patch: { label: modified.label } };
    },
    toDeleteInput: (id) => ({ id }),
    ...overrides,
  });

/** The active workspace only, for now; read-only. */
export const gitStateCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<GitStateRow, string> =>
  ipcCollectionOptions<GitStateRow, string>({
    id: "gitState",
    table: tableOf(transport, (db) => db.gitState),
    getKey: (row) => row.checkoutKey,
    ...overrides,
  });

const PREFS_WRITABLE = [
  "theme",
  "language",
  "sidebar",
  "pinned",
  "models",
  "defaultMode",
  "workspaceExpanded",
  "lastPickedWorkspaceId",
  "recentFolders",
  "creditsExhaustedAt",
  "browserHomepage",
  "onboardingStep",
  "dismissals",
  "panes",
  "motion",
  "sounds",
] as const;

/**
 * The prefs fields that group leaves (B.2): a write merges into the group,
 * leaf by leaf, as main's prefs store does. Keyed by PrefsGroup, so a new
 * group cannot be left out (it would replace its siblings optimistically).
 */
const GROUP_FIELDS: Record<PrefsGroup, true> = {
  sidebar: true,
  pinned: true,
  models: true,
  dismissals: true,
  motion: true,
  sounds: true,
  appearance: true,
  notch: true,
  tour: true,
};
export const PREFS_GROUPS: ReadonlySet<string> = new Set(
  Object.keys(GROUP_FIELDS)
);

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * What a collection update sends: TanStack hands over whole groups, and
 * provenance is per leaf (B.2), so only the leaves that differ from the row
 * the user saw are sent. An explicit choice of the current value never
 * reaches here (TanStack drops equal writes); `updatePrefs` sends those.
 */
const changedPrefsLeaves = (
  changes: Partial<PrefsRow>,
  original: PrefsRow
): PrefsPatch => {
  const patch: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    const before = (original as unknown as Record<string, unknown>)[field];
    if (!PREFS_GROUPS.has(field)) {
      if (!sameValue(value, before)) patch[field] = value;
      continue;
    }
    const leaves: Record<string, unknown> = {};
    for (const [leaf, inner] of Object.entries(value as object))
      if (!sameValue(inner, (before as Record<string, unknown>)[leaf]))
        leaves[leaf] = inner;
    if (Object.keys(leaves).length > 0) patch[field] = leaves;
  }
  return patch as PrefsPatch;
};

/** One row, `"app"`; update only. */
export const prefsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<PrefsRow, "app"> =>
  ipcCollectionOptions<PrefsRow, "app">({
    id: "prefs",
    table: tableOf(transport, (db) => db.prefs),
    getKey: () => "app",
    startSync: true,
    toUpdateInput: (_id, changes, _modified, original) => {
      writablePatch("prefs", changes, PREFS_WRITABLE, []);
      return { patch: changedPrefsLeaves(changes, original) };
    },
    ...overrides,
  });

/** What `updatePrefs` needs of the prefs collection. */
export interface PrefsCollectionLike {
  has(key: "app"): boolean;
  update(key: "app", callback: (draft: PrefsRow) => void): unknown;
  readonly status: string;
  startSyncImmediate(): void;
  readonly utils: IpcCollectionUtils;
}

/**
 * The renderer's prefs write (B.2 provenance): every leaf in `patch` is
 * sent, even one equal to what the row already holds, so main marks it the
 * user's and a later legacy import cannot overwrite it. A plain
 * `collection.update` cannot do that: TanStack drops an assignment of the
 * current value before any handler runs. Visible changes are applied
 * optimistically and roll back if main refuses.
 */
export const createUpdatePrefs =
  (collection: PrefsCollectionLike, transport: LazyTransport) =>
  async (patch: PrefsPatch): Promise<void> => {
    const send = async (): Promise<void> => {
      const db = (await transport()).client.db;
      const position = await db.prefs.update({ patch });
      await collection.utils.awaitEcho(position, collection);
    };
    const transaction = createTransaction({
      autoCommit: false,
      mutationFn: send,
    });
    if (collection.has("app"))
      transaction.mutate(() => {
        collection.update("app", (draft) => {
          for (const [field, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            const target = draft as unknown as Record<string, unknown>;
            target[field] = PREFS_GROUPS.has(field)
              ? { ...(target[field] as object), ...(value as object) }
              : value;
          }
        });
      });
    // Nothing visible changes: TanStack would not run the mutation at all.
    const visible = transaction.mutations.length > 0;
    await transaction.commit();
    if (!visible) await send();
  };
