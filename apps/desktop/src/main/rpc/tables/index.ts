/**
 * The DB tables (spec 00 B): one `TableFeed` per table, and the triggers that
 * re-diff them. Bus events cover what emits one; the direct hooks cover
 * writes that do not; over-notifying is harmless (diff-based).
 *
 * No Electron: the router reaches this through `RpcDeps.tables`.
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
import type { IpcEvent } from "#shared/contracts";

import type { PrefsStore } from "../../services/config/prefs-store";
import type { MainEventBus } from "../event-bus";
import { readGitStateRows, sameGitState } from "./git-state";
import { MemoryWatchers, readMemoryRows } from "./memories";
import { readRoutineRunRows } from "./routine-runs";
import { readRoutineRows, ROUTINES_CLOCK_MS } from "./routines";
import { readSessionRows, SESSION_EVENTS } from "./sessions";
import type { TableSources, Unhook } from "./sources";
import { TableFeed } from "./table-feed";
import { readWorkspaceRows } from "./workspaces";

export interface Tables {
  sessions: TableFeed<SessionRow>;
  bots: TableFeed<BotRow>;
  routines: TableFeed<RoutineRow>;
  routineRuns: TableFeed<RoutineRunRow>;
  artifacts: TableFeed<ArtifactRow>;
  memories: TableFeed<MemoryRow>;
  workspaces: TableFeed<WorkspaceRow>;
  gitState: TableFeed<GitStateRow>;
  prefs: TableFeed<PrefsRow, "app">;
  /** The prefs row's only writer (B.2 provenance). */
  prefsStore: PrefsStore;
  /** Removes every trigger, watcher and timer. */
  dispose(): void;
}

export type TableName = Exclude<keyof Tables, "prefsStore" | "dispose">;

export const TABLE_NAMES: TableName[] = [
  "sessions",
  "bots",
  "routines",
  "routineRuns",
  "artifacts",
  "memories",
  "workspaces",
  "gitState",
  "prefs",
];

export interface CreateTablesOptions {
  bus: MainEventBus;
  sources: TableSources;
  prefsStore: PrefsStore;
  /** Watch the memory files the agent child writes (off for fakes). */
  watchMemories?: boolean;
  /** `routines` re-diff period for `nextRunAt`; null disables (tests). */
  routinesClockMs?: number | null;
}

/** Which tables an `IpcEvent` can change, and whether it invalidates them. */
const TRIGGERS: Partial<
  Record<IpcEvent["type"], { notify?: TableName[]; reset?: TableName[] }>
> = {
  ...Object.fromEntries(
    SESSION_EVENTS.map((type) => [type, { notify: ["sessions"] }])
  ),
  "sessions-reloaded": { reset: ["sessions"] },
  // Routines and memories show bot names.
  "bots-updated": { notify: ["bots", "routines", "memories"] },
  "cronjobs-updated": { notify: ["routines"] },
  "session-artifacts-updated": { notify: ["artifacts"] },
  "metadata-updated": { notify: ["workspaces", "gitState"] },
  "git-state-updated": { notify: ["gitState"] },
};

export const createTables = (options: CreateTablesOptions): Tables => {
  const { bus, sources, prefsStore } = options;
  const byId = <R extends { id: string }>(row: R): string => row.id;

  const tables: Omit<Tables, "dispose"> = {
    sessions: new TableFeed({
      name: "sessions",
      read: () => readSessionRows(sources),
      getKey: byId,
    }),
    bots: new TableFeed({
      name: "bots",
      read: () => sources.listBots(),
      getKey: byId,
    }),
    routines: new TableFeed({
      name: "routines",
      read: () => readRoutineRows(sources),
      getKey: byId,
    }),
    routineRuns: new TableFeed({
      name: "routineRuns",
      read: () => readRoutineRunRows(sources),
      getKey: (row) => row.sessionId,
    }),
    artifacts: new TableFeed({
      name: "artifacts",
      read: () => sources.listSessionArtifacts(),
      getKey: byId,
    }),
    memories: new TableFeed({
      name: "memories",
      read: () => readMemoryRows(sources),
      getKey: byId,
    }),
    workspaces: new TableFeed({
      name: "workspaces",
      read: () => readWorkspaceRows(sources),
      getKey: byId,
    }),
    gitState: new TableFeed({
      name: "gitState",
      read: () => readGitStateRows(sources),
      getKey: (row) => row.workspaceId,
      equals: sameGitState,
    }),
    prefs: new TableFeed<PrefsRow, "app">({
      name: "prefs",
      read: () => [prefsStore.get()],
      getKey: () => "app",
    }),
    prefsStore,
  };

  const unhooks: Unhook[] = [
    bus.listen(
      (event) => TRIGGERS[event.type] != null,
      (event) => {
        const trigger = TRIGGERS[event.type]!;
        for (const name of trigger.reset ?? []) tables[name].reset();
        for (const name of trigger.notify ?? []) tables[name].notify();
      }
    ),
    // Derived: every sessions batch can change the runs.
    tables.sessions.onPublish(() => tables.routineRuns.notify()),
    sources.onSessionsChanged(() => tables.sessions.notify()),
    sources.onBotsWritten(() => tables.bots.notify()),
    sources.onRoutinesWritten(() => tables.routines.notify()),
    sources.onWorkspacesChanged(() => {
      tables.workspaces.notify();
      tables.gitState.notify();
    }),
    prefsStore.onChanged(() => tables.prefs.notify()),
  ];

  if (options.watchMemories !== false) {
    const watchers = new MemoryWatchers({
      home: sources.botHome(),
      onChange: () => {
        tables.memories.notify();
        bus.dispatchChannel("memory", { type: "changed" });
      },
    });
    unhooks.push(() => watchers.close());
  }

  const clockMs =
    options.routinesClockMs === undefined
      ? ROUTINES_CLOCK_MS
      : options.routinesClockMs;
  if (clockMs != null) {
    const clock = setInterval(() => tables.routines.notify(), clockMs);
    clock.unref?.();
    unhooks.push(() => clearInterval(clock));
  }

  return {
    ...tables,
    dispose: () => {
      for (const unhook of unhooks.splice(0)) unhook();
    },
  };
};
