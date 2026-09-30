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
import { MemoryWatchers, readMemoryRows, type WatchFactory } from "./memories";
import { readRoutineRunRows } from "./routine-runs";
import { readRoutineRows, ROUTINES_CLOCK_MS } from "./routines";
import { readSessionRows, SESSION_EVENTS } from "./sessions";
import type { TableSources, Unhook } from "./sources";
import { stableJson, TableFeed } from "./table-feed";
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
  /** The directory-watch primitive for `memories`; `fs.watch` by default. */
  watch?: WatchFactory;
  /** `routines` re-diff period for `nextRunAt`; null disables (tests). */
  routinesClockMs?: number | null;
  /**
   * `artifacts` re-diff period while it has a reader: rows are filtered by
   * whether their file exists, which no ledger write reports. Null disables.
   */
  artifactsPollMs?: number | null;
}

/** An artifact deleted or restored outside the app shows within this. */
export const ARTIFACTS_POLL_MS = 2_000;

/** Which tables an `IpcEvent` can change, and whether it invalidates them. */
const TRIGGERS: Partial<
  Record<IpcEvent["type"], { notify?: TableName[]; reset?: TableName[] }>
> = {
  // routineRuns is derived from the sessions, but it is notified from the
  // same triggers rather than from a sessions batch: a sessions feed nobody
  // reads publishes nothing to chain on.
  ...Object.fromEntries(
    SESSION_EVENTS.map((type) => [
      type,
      { notify: ["sessions", "routineRuns"] },
    ])
  ),
  "sessions-reloaded": { reset: ["sessions"], notify: ["routineRuns"] },
  // Bot names reach routines and memories only through a bots.json write
  // (the store hook below); this event also fires on every transcript save.
  "bots-updated": { notify: ["bots"] },
  "cronjobs-updated": { notify: ["routines"] },
  "session-artifacts-updated": { notify: ["artifacts"] },
  "metadata-updated": { notify: ["workspaces", "gitState"] },
  "git-state-updated": { notify: ["gitState"] },
};

/**
 * A reference count over the ways something can be wanted, starting it on
 * the first and stopping it after the last.
 */
const demand = (start: () => () => void) => {
  let count = 0;
  let stop: (() => void) | null = null;
  return (): (() => void) => {
    count += 1;
    if (count === 1) stop = start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      count -= 1;
      if (count === 0) {
        const done = stop;
        stop = null;
        done?.();
      }
    };
  };
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
      getKey: (row) => row.checkoutKey,
      equals: sameGitState,
    }),
    prefs: new TableFeed<PrefsRow, "app">({
      name: "prefs",
      read: () => [prefsStore.get()],
      getKey: () => "app",
    }),
    prefsStore,
  };

  const notifySessions = (): void => {
    tables.sessions.notify();
    tables.routineRuns.notify();
  };

  /**
   * `memory.events { changed }` invalidates `memory.bots` (spec 00 B.2).
   * Watchers report file changes; a bots.json write can change the view
   * too (a rename, a bot added or removed) without touching a memory file,
   * so it is compared with the last view published.
   */
  let botsView: string | null = null;
  const readBotsView = (): string | null => {
    try {
      return stableJson(sources.listBotMemories());
    } catch (error) {
      console.error("[db] memory.bots read failed", error);
      return null;
    }
  };
  const memoryChanged = (): void => {
    tables.memories.notify();
    botsView = readBotsView();
    bus.dispatchChannel("memory", { type: "changed" });
  };

  // The watchers run only while someone reads `memories` or listens to
  // `memory.events`: the legacy-only app pays nothing.
  const wantMemory = demand(() => {
    botsView = readBotsView();
    if (options.watchMemories === false)
      return () => {
        botsView = null;
      };
    const watchers = new MemoryWatchers({
      home: sources.botHome(),
      onChange: memoryChanged,
      watch: options.watch,
    });
    return () => {
      watchers.close();
      botsView = null;
    };
  });

  const unhooks: Unhook[] = [
    bus.listen(
      (event) => TRIGGERS[event.type] != null,
      (event) => {
        const trigger = TRIGGERS[event.type]!;
        for (const name of trigger.reset ?? []) tables[name].reset();
        for (const name of trigger.notify ?? []) tables[name].notify();
      }
    ),
    // A sessions batch from a mutation's notifyNow chains too.
    tables.sessions.onPublish(() => tables.routineRuns.notify()),
    sources.onSessionsChanged(notifySessions),
    sources.onBotsWritten(() => {
      tables.bots.notify();
      // Routines and memories show bot names.
      tables.routines.notify();
      tables.memories.notify();
      if (botsView == null) return;
      const next = readBotsView();
      if (next == null || next === botsView) return;
      botsView = next;
      bus.dispatchChannel("memory", { type: "changed" });
    }),
    // A result recorded after the session notification (a timeout, a
    // start failure) changes run rows too (spec 05 §31.5 f).
    sources.onRoutinesWritten(() => {
      tables.routines.notify();
      tables.routineRuns.notify();
    }),
    sources.onWorkspacesChanged(() => {
      tables.workspaces.notify();
      tables.gitState.notify();
    }),
    prefsStore.onChanged(() => tables.prefs.notify()),
    sources.onCheckoutRowsChanged?.(() => tables.gitState.notify()) ??
      (() => undefined),
    // Fingerprints cost git calls per refresh: only while someone reads.
    tables.gitState.whileSubscribed(
      () => sources.wantGitFingerprints?.() ?? (() => undefined)
    ),
    tables.memories.whileSubscribed(wantMemory),
    bus.whileListened("memory", wantMemory),
  ];

  /** Re-diff `feed` every `ms` while it has a reader. */
  const every = (
    feed: Pick<TableFeed<unknown>, "whileSubscribed" | "notify">,
    ms: number
  ): Unhook =>
    feed.whileSubscribed(() => {
      const timer = setInterval(() => feed.notify(), ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });

  const clockMs =
    options.routinesClockMs === undefined
      ? ROUTINES_CLOCK_MS
      : options.routinesClockMs;
  if (clockMs != null) unhooks.push(every(tables.routines, clockMs));

  const artifactsMs =
    options.artifactsPollMs === undefined
      ? ARTIFACTS_POLL_MS
      : options.artifactsPollMs;
  if (artifactsMs != null) unhooks.push(every(tables.artifacts, artifactsMs));

  return {
    ...tables,
    dispose: () => {
      for (const unhook of unhooks.splice(0)) unhook();
    },
  };
};
