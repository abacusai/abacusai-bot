/**
 * One set of collection options per `db.*` table (spec 00 B.2, B.3): the key,
 * what each mutation sends, and whether the shell needs the table at once.
 * Each takes a lazy transport, so tests pass an in-memory one and the app
 * passes `getTransport`.
 */
import type {
  ArtifactRow,
  BotRow,
  GitStateRow,
  MemoryRow,
  PrefsRow,
  RoutineRow,
  RoutineRunRow,
  SessionRow,
  WorkspaceRow,
} from "#shared/contract/rows";

import type { Transport } from "../transport/types";
import {
  ipcCollectionOptions,
  type IpcCollectionConfig,
  type IpcCollectionOptions,
  type IpcTableClient,
} from "./ipc-collection-options";

export type LazyTransport = () => Promise<Transport>;

type Db = Transport["client"]["db"];

/** Extra knobs a caller (a test) may set on any table. */
export type TableOverrides = Pick<
  IpcCollectionConfig<object, string>,
  "echoTimeoutMs" | "retryDelayMs" | "startSync"
>;

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

const byId = <Row extends { id: string }>(row: Row): string => row.id;

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
    toInsertInput: (row) => ({ id: row.id, workspaceId: row.workspaceId }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: pickDefined(changes, ["label", "model"] as const),
    }),
    toDeleteInput: (id) => ({ id }),
    ...overrides,
  });

const BOT_CREATE_FIELDS = [
  "name",
  "title",
  "description",
  "persona",
  "avatarColor",
  "avatarShape",
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
  "model",
  "channel",
] as const;

export const botsCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<BotRow, string> =>
  ipcCollectionOptions<BotRow, string>({
    id: "bots",
    table: tableOf(transport, (db) => db.bots),
    getKey: byId,
    toInsertInput: (row) => ({
      ...pickDefined(row, BOT_CREATE_FIELDS),
      id: row.id,
    }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: pickDefined(changes, BOT_UPDATE_FIELDS),
    }),
    toDeleteInput: (id) => ({ id }),
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
] as const;

export const routinesCollectionOptions = (
  transport: LazyTransport,
  overrides: TableOverrides = {}
): IpcCollectionOptions<RoutineRow, string> =>
  ipcCollectionOptions<RoutineRow, string>({
    id: "routines",
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
    }),
    toUpdateInput: (id, changes) => ({
      id,
      patch: {
        ...pickDefined(changes, ROUTINE_UPDATE_FIELDS),
        ...(changes.webhookToken !== undefined
          ? { webhook: changes.webhookToken != null }
          : {}),
      },
    }),
    toDeleteInput: (id) => ({ id }),
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
    toUpdateInput: (id, _changes, modified) => ({
      id,
      patch: { label: modified.label },
    }),
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
    getKey: (row) => row.workspaceId,
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
    toUpdateInput: (_id, changes) => ({
      patch: pickDefined(changes, PREFS_WRITABLE),
    }),
    ...overrides,
  });
