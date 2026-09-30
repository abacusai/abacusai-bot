/**
 * One collection per `db.*` table (spec 01 §8.3). Built by a factory over a
 * `DbSource` so tests (and the dev fixture tables) get fresh instances; the
 * app's singletons live in index.ts.
 *
 * `prefs`, `sessions` and `workspaces` start syncing at once and are never
 * garbage-collected (the shell needs them for the whole session); the others
 * load when a route loader calls `preload()`.
 */
import { createCollection } from "@tanstack/db";

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
} from "#shared/contract";

import { ipcCollectionOptions } from "./ipc-collection-options";
import { tableOf, type DbSource } from "./table-source";

/** The shell's tables: live for the whole document. */
const SHELL = { startSync: true, gcTime: 0 } as const;

export const createCollections = (
  source: DbSource,
  options: { backoffMs?: readonly number[]; echoTimeoutMs?: number } = {}
) => {
  const common = {
    ...(options.backoffMs === undefined
      ? {}
      : { backoffMs: options.backoffMs }),
    ...(options.echoTimeoutMs === undefined
      ? {}
      : { echoTimeoutMs: options.echoTimeoutMs }),
  };
  return {
    prefs: createCollection(
      ipcCollectionOptions<PrefsRow, "app">({
        ...common,
        ...SHELL,
        id: "prefs",
        table: tableOf<PrefsRow, "app">(source, "prefs"),
        getKey: (row) => row.id,
        // Only fields the user changed travel; valibot refuses unknown keys.
        toUpdateInput: (_key, changes) => {
          const { id: _id, updatedAt: _updatedAt, ...patch } = changes;
          return { patch };
        },
      })
    ),
    sessions: createCollection(
      ipcCollectionOptions<SessionRow, string>({
        ...common,
        ...SHELL,
        id: "sessions",
        table: tableOf<SessionRow>(source, "sessions"),
        getKey: (row) => row.id,
        toInsertInput: (row) => ({ id: row.id, workspaceId: row.workspaceId }),
        toUpdateInput: (id, changes) => ({
          id,
          patch: {
            ...(changes.label === undefined ? {} : { label: changes.label }),
            ...(changes.model == null ? {} : { model: changes.model }),
          },
        }),
        toDeleteInput: (id) => ({ id }),
      })
    ),
    workspaces: createCollection(
      ipcCollectionOptions<WorkspaceRow, string>({
        ...common,
        ...SHELL,
        id: "workspaces",
        table: tableOf<WorkspaceRow>(source, "workspaces"),
        getKey: (row) => row.id,
        toUpdateInput: (id, _changes, modified) => ({
          id,
          patch: { label: modified.label },
        }),
        toDeleteInput: (id) => ({ id }),
      })
    ),
    bots: createCollection(
      ipcCollectionOptions<BotRow, string>({
        ...common,
        id: "bots",
        table: tableOf<BotRow>(source, "bots"),
        getKey: (row) => row.id,
        // The client id passes through (spec 00 B.2).
        toInsertInput: (row) => ({ ...row }),
        toUpdateInput: (id, changes) => ({ id, patch: changes }),
        toDeleteInput: (id) => ({ id }),
      })
    ),
    routines: createCollection(
      ipcCollectionOptions<RoutineRow, string>({
        ...common,
        id: "routines",
        table: tableOf<RoutineRow>(source, "routines"),
        getKey: (row) => row.id,
        toUpdateInput: (id, changes) => ({ id, patch: changes }),
        toDeleteInput: (id) => ({ id }),
      })
    ),
    routineRuns: createCollection(
      ipcCollectionOptions<RoutineRunRow, string>({
        ...common,
        id: "routineRuns",
        table: tableOf<RoutineRunRow>(source, "routineRuns"),
        getKey: (row) => row.sessionId,
      })
    ),
    artifacts: createCollection(
      ipcCollectionOptions<ArtifactRow, string>({
        ...common,
        id: "artifacts",
        table: tableOf<ArtifactRow>(source, "artifacts"),
        getKey: (row) => row.id,
      })
    ),
    memories: createCollection(
      ipcCollectionOptions<MemoryRow, string>({
        ...common,
        id: "memories",
        table: tableOf<MemoryRow>(source, "memories"),
        getKey: (row) => row.id,
        toDeleteInput: (_id, original) => ({
          id: original.id,
          scope: original.scope,
          target: original.target,
          botId: original.botId,
          index: original.index,
          entry: original.entry,
        }),
      })
    ),
    gitState: createCollection(
      ipcCollectionOptions<GitStateRow, string>({
        ...common,
        id: "gitState",
        table: tableOf<GitStateRow>(source, "gitState"),
        getKey: (row) => row.workspaceId,
      })
    ),
  };
};

export type Collections = ReturnType<typeof createCollections>;
