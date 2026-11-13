/**
 * B-T3: each table's triggers against the real stores, with
 * `ABACUSAI_BOT_HOME` in a temp directory. The session store's electron-store
 * is replaced by a map, as agent-session-manager.test.ts does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => os.tmpdir() } }));

const stored = new Map<string, unknown>();
vi.mock("../../services/session/workspace-store", () => ({
  workspaceStore: {
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
  },
}));

import { ConflictError } from "@abacus-ai/contract/conflict";
import type { ChangeBatch } from "@abacus-ai/contract/contract/rows";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
import type { RoutineListItem } from "@abacus-ai/contract/routines";

import { createTables, type Tables } from ".";
import {
  createJob,
  getJob,
  listJobs,
  onCronStoreWrite,
  recordRun,
} from "../../services/agent-tools/cron-store";
import {
  createBot,
  listBots,
  onBotStoreWrite,
  removeBot,
  updateBot,
} from "../../services/bots/bot-store";
import { PrefsStore } from "../../services/config/prefs-store";
import { memoryRows, saveNote } from "../../services/memory/memory-service";
import { AgentSessionManagerService } from "../../services/session/agent-session-manager-service";
import { SessionArtifactsService } from "../../services/session/session-artifacts-service";
import { WorkspaceRuntimeService } from "../../services/workspace/workspace-runtime-service";
import { WorkspaceService } from "../../services/workspace/workspace-service";
import { followPrefsTheme } from "../../startup-theme";
import { MainEventBus } from "../event-bus";
import { connectInProcess, fakeDeps } from "../testing";
import { MemoryWatcher, type WatchFactory } from "./memories";
import type { TableSources } from "./sources";
import type { TableFeed } from "./table-feed";

let home: string;
let tables: Tables | null = null;
let routines: RoutineListItem[] = [];

/**
 * A synchronous stand-in for `fs.watch`: the test emits events by hand, so the
 * reconcile logic is asserted without filesystem-event latency (FSEvents on
 * macOS starts late and coalesces). `failing` directories throw on arming.
 */
const fakeWatch = () => {
  type Armed = {
    dir: string;
    listener: (event: string, name: string | null) => void;
    closed: boolean;
  };
  const all: Armed[] = [];
  const failing = new Map<string, string>();
  const factory: WatchFactory = (dir, listener) => {
    const code = failing.get(dir);
    if (code != null) throw Object.assign(new Error(code), { code });
    const armed: Armed = { dir, listener, closed: false };
    all.push(armed);
    return {
      close: () => {
        armed.closed = true;
      },
    };
  };
  return {
    factory,
    failing,
    emit: (dir: string, event: string, name: string | null) => {
      for (const armed of all)
        if (armed.dir === dir && !armed.closed) armed.listener(event, name);
    },
    live: (dir: string) =>
      all.filter((armed) => armed.dir === dir && !armed.closed).length,
    armedCount: (dir: string) =>
      all.filter((armed) => armed.dir === dir).length,
  };
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "db-tables-"));
  process.env.ABACUSAI_BOT_HOME = home;
  stored.clear();
  routines = [];
});

afterEach(() => {
  vi.useRealTimers();
  tables?.dispose();
  tables = null;
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const noHook = () => () => undefined;

const sourcesFor = (
  sessions: AgentSessionManagerService,
  overrides: Partial<TableSources> = {}
): TableSources => ({
  listAllAgentSessions: () => sessions.listAll(),
  listSessionTurnStates: () => [],
  onSessionsChanged: (listener) => sessions.onChanged(listener),
  listBots,
  onBotsWritten: onBotStoreWrite,
  listRoutines: () => routines,
  onRoutinesWritten: noHook,
  listSessionArtifacts: () => [],
  listMemoryRows: memoryRows,
  getMetadata: () => ({
    workspaces: [],
    activeWorkspaceId: null,
    materialIconsBasePath: null,
    lastUpdatedAt: "",
  }),
  onWorkspacesChanged: noHook,
  getGitState: () => {
    throw new Error("no git state in this test");
  },
  gitStateWorkspacePath: () => null,
  botHome: () => home,
  ...overrides,
});

const setup = (
  options: {
    watchMemories?: boolean;
    watch?: WatchFactory;
    prefsStore?: PrefsStore;
    sources?: Partial<TableSources>;
    routinesClockMs?: number | null;
    artifactsPollMs?: number | null;
  } = {}
) => {
  const bus = new MainEventBus();
  const sessions = new AgentSessionManagerService();
  sessions.initialize(["ws-1"]);
  const sources = sourcesFor(sessions, options.sources);
  const prefsStore =
    options.prefsStore ??
    new PrefsStore({ file: path.join(home, "prefs.json") });
  tables = createTables({
    bus,
    sources,
    prefsStore,
    watchMemories: options.watchMemories ?? false,
    watch: options.watch,
    routinesClockMs: options.routinesClockMs ?? null,
    artifactsPollMs: options.artifactsPollMs ?? null,
  });
  return { bus, sessions, sources, tables, prefsStore };
};

/** A live reader: snapshot, then `changes()` past its hello. */
const reader = async <Row, Key extends string>(feed: TableFeed<Row, Key>) => {
  feed.snapshot();
  const stream = feed.subscribe();
  await stream.next();
  return {
    next: async (ms = 2_000): Promise<ChangeBatch<Row, Key>> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no ${feed.name} batch in ${ms} ms`)),
          ms
        );
      });
      try {
        const result = await Promise.race([stream.next(), timeout]);
        if (result.done === true) throw new Error("stream ended");
        return result.value;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => stream.return(),
  };
};

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("DB table wiring (B-T3)", { timeout: 20_000 }, () => {
  it("bots: create, update and delete through the store are one batch each", async () => {
    const { tables } = setup();
    const bots = await reader(tables.bots);

    const bot = createBot(
      { name: "Ada", description: "Counts", avatarAccessory: "glasses" },
      "bot-ada"
    );
    expect(bot.id).toBe("bot-ada");
    await expect(bots.next()).resolves.toMatchObject({
      seq: 1,
      changes: [
        {
          type: "insert",
          key: "bot-ada",
          value: { avatarAccessory: "glasses" },
        },
      ],
    });

    updateBot(bot.id, { name: "Ada L.", avatarAccessory: "crown" });
    await expect(bots.next()).resolves.toMatchObject({
      seq: 2,
      changes: [
        { type: "update", value: { name: "Ada L.", avatarAccessory: "crown" } },
      ],
    });

    removeBot(bot.id);
    await expect(bots.next()).resolves.toMatchObject({
      seq: 3,
      changes: [{ type: "delete", key: "bot-ada" }],
    });
    await settle();
    expect(tables.bots.seq).toBe(3);

    // A taken caller id is refused, not overwritten.
    createBot({ name: "B", description: "x" }, "bot-b");
    expect(() => createBot({ name: "C", description: "y" }, "bot-b")).toThrow(
      ConflictError
    );
    await bots.close();
  });

  it("routines: a cronjobs-updated event re-diffs", async () => {
    const { tables, bus } = setup();
    const feed = await reader(tables.routines);
    routines = [
      {
        id: "job-1",
        name: "Daily",
        schedule: "0 9 * * *",
        runAt: null,
        webhookToken: null,
        prompt: "p",
        workspaceId: null,
        botId: null,
        enabled: true,
        createdAt: 1,
        lastRunAt: null,
        lastResult: null,
        runs: Array.from({ length: 600 }, (_, i) => ({
          id: `attempt-${i}`,
          at: 1000 - i,
          trigger: "schedule" as const,
          result: `run ${i}`,
          kind: "unknown" as const,
          sessionId: null,
          attemptId: null,
        })),
        nextRunAt: 5,
        webhookUrl: null,
        webhookPublicPending: false,
        botName: null,
      },
    ];
    bus.dispatch({ type: "cronjobs-updated", emittedAt: "" });
    const batch = await feed.next();
    expect(batch).toMatchObject({
      seq: 1,
      changes: [{ type: "insert", key: "job-1" }],
    });
    const row = (batch as { changes: { value: Record<string, unknown> }[] })
      .changes[0]!.value;
    expect(row.runs).toBeUndefined();
    expect(row.recentRuns).toHaveLength(500);
    expect((row.recentRuns as { at: number }[])[0]).toMatchObject({
      at: 1000,
    });
    await feed.close();
  });

  it("sessions: setRunOutcome (no event) updates sessions and routineRuns", async () => {
    const { tables, sessions } = setup();
    const run = sessions.create("ws-1", "job-1");
    const sessionFeed = await reader(tables.sessions);
    const runFeed = await reader(tables.routineRuns);
    expect(tables.routineRuns.snapshot().rows).toMatchObject([
      { sessionId: run.id, routineId: "job-1", outcome: "running" },
    ]);

    sessions.setRunOutcome(run.id, "completed");
    await expect(sessionFeed.next()).resolves.toMatchObject({
      changes: [
        { type: "update", key: run.id, value: { runOutcome: "completed" } },
      ],
    });
    await expect(runFeed.next()).resolves.toMatchObject({
      changes: [
        { type: "update", key: run.id, value: { outcome: "completed" } },
      ],
    });
    await sessionFeed.close();
    await runFeed.close();
  });

  // R5-T10 (main side), spec 05 §31.5 f: a result recorded after the
  // session notification reaches a subscribed routineRuns client, joined to
  // its attempt by session id.
  it("routineRuns: a cron-only write (a timeout) updates the run's attempt and result", async () => {
    const job = createJob({ prompt: "p", schedule: "0 9 * * *" });
    const { tables, sessions } = setup({
      sources: {
        listRoutines: () => listJobs() as unknown as RoutineListItem[],
        onRoutinesWritten: onCronStoreWrite,
      },
    });
    const run = sessions.create("ws-1", job.id);
    const attempt = recordRun(job.id, `started session ${run.id}`, "manual", {
      kind: "started",
      sessionId: run.id,
    });
    const feed = await reader(tables.routineRuns);
    expect(tables.routineRuns.snapshot().rows).toMatchObject([
      {
        sessionId: run.id,
        attemptId: attempt!.id,
        result: `started session ${run.id}`,
      },
    ]);

    // No session record changes: only cronjobs.json is written.
    const timeout = recordRun(
      job.id,
      "failed: the run was stopped after 30 minutes",
      "schedule",
      { kind: "timed-out", sessionId: run.id, attemptId: attempt!.id }
    );
    await expect(feed.next()).resolves.toMatchObject({
      changes: [
        {
          type: "update",
          key: run.id,
          value: {
            attemptId: attempt!.id,
            result: "failed: the run was stopped after 30 minutes",
          },
        },
      ],
    });
    // Ids are persisted: prepending more entries never changes them.
    recordRun(job.id, "skipped: the previous run is still going", "schedule");
    const stored = getJob(job.id)!.runs;
    expect(stored.map((entry) => entry.id).slice(1)).toEqual([
      timeout!.id,
      attempt!.id,
    ]);
    expect(stored[0]).toMatchObject({ kind: "skipped", sessionId: null });
    await feed.close();
  });

  it("sessions: a client id is honoured once, then CONFLICT; sessions-reloaded resets", async () => {
    const { tables, sessions, bus } = setup();
    const feed = await reader(tables.sessions);
    const id = "5b0e6a0c-0000-4000-8000-000000000001";
    expect(sessions.create("ws-1", null, null, null, id).id).toBe(id);
    expect(() => sessions.create("ws-1", null, null, null, id)).toThrow(
      ConflictError
    );
    await expect(feed.next()).resolves.toMatchObject({
      changes: [{ type: "insert", key: id }],
    });
    bus.dispatch({ type: "sessions-reloaded", emittedAt: "" } as never);
    await expect(feed.next()).resolves.toMatchObject({ kind: "reset" });
    await feed.close();
  });

  it("memories: a note saved in the memory folder arrives promptly", async () => {
    const watch = fakeWatch();
    const { tables, bus } = setup({
      watchMemories: true,
      watch: watch.factory,
    });
    const feed = await reader(tables.memories);
    let notices = 0;
    bus.listenChannel("memory", () => {
      notices += 1;
    });
    // Nothing exists yet: the watcher waits on the home for `memory`.
    expect(watch.live(home)).toBe(1);

    const started = Date.now();
    await saveNote({ scope: "you", type: "fact", text: "Lives in Oslo." });
    watch.emit(home, "rename", "memory");
    const batch = await feed.next(2000);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(batch).toMatchObject({
      changes: [
        {
          type: "insert",
          value: {
            id: "you/lives-in-oslo.md",
            scope: "you",
            body: "Lives in Oslo.",
            by: "you",
          },
        },
      ],
    });
    expect(notices).toBeGreaterThan(0);
    // Now on the history itself, where every later change is appended.
    expect(watch.live(path.join(home, "memory", ".history"))).toBe(1);
    expect(watch.live(home)).toBe(0);
    await feed.close();
  });

  it("memory watcher moves down to the history as it appears", async () => {
    const watch = fakeWatch();
    const changes = vi.fn();
    const watcher = new MemoryWatcher({
      home,
      onChange: changes,
      debounceMs: 1,
      watch: watch.factory,
    });
    const memory = path.join(home, "memory");
    const history = path.join(memory, ".history");
    try {
      expect(watcher.watchedPath()).toBe(home);
      // Another store appearing in the home is not memory.
      watch.emit(home, "rename", "bots");
      fs.mkdirSync(memory);
      watch.emit(home, "rename", "memory");
      await vi.waitFor(() => expect(watcher.watchedPath()).toBe(memory));
      fs.mkdirSync(history);
      watch.emit(memory, "rename", ".history");
      await vi.waitFor(() => expect(watcher.watchedPath()).toBe(history));
      expect(watch.live(home)).toBe(0);
      expect(watch.live(memory)).toBe(0);
      expect(changes).toHaveBeenCalled();
    } finally {
      watcher.close();
    }
    expect(watcher.watchedPath()).toBeNull();
    expect(watch.live(history)).toBe(0);
  });

  it("memory watcher reconciles a history created while the initial watcher starts", async () => {
    vi.useFakeTimers();
    const watch = fakeWatch();
    const changes = vi.fn();
    const history = path.join(home, "memory", ".history");
    const watcher = new MemoryWatcher({
      home,
      onChange: changes,
      debounceMs: 1,
      watch: (dir, listener, onError) => {
        if (dir === home) {
          fs.mkdirSync(history, { recursive: true });
          fs.writeFileSync(path.join(history, "2026-11.jsonl"), "{}\n");
        }
        return watch.factory(dir, listener, onError);
      },
    });
    try {
      // No event arrives for the write made before the watcher was ready.
      await vi.advanceTimersByTimeAsync(10);
      expect(watcher.watchedPath()).toBe(history);
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      watcher.close();
    }
  });

  it("memory watcher notifies after arming, for writes that beat it", async () => {
    const watch = fakeWatch();
    const changes = vi.fn();
    const watcher = new MemoryWatcher({
      home,
      onChange: changes,
      debounceMs: 1,
      watch: watch.factory,
    });
    const history = path.join(home, "memory", ".history");
    try {
      // Created and written before its watcher exists: no event will come.
      fs.mkdirSync(history, { recursive: true });
      fs.writeFileSync(path.join(history, "2026-11.jsonl"), "{}\n");
      watch.emit(home, "rename", "memory");
      await vi.waitFor(() => expect(watcher.watchedPath()).toBe(history));
      // The arming pass and its settle pass both notify.
      await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(changes).toHaveBeenCalledTimes(2);
    } finally {
      watcher.close();
    }
  });

  it("memory watcher retries a history that cannot be watched yet", async () => {
    vi.useFakeTimers();
    const watch = fakeWatch();
    const history = path.join(home, "memory", ".history");
    fs.mkdirSync(history, { recursive: true });
    watch.failing.set(history, "EPERM");
    const changes = vi.fn();
    const watcher = new MemoryWatcher({
      home,
      onChange: changes,
      debounceMs: 10,
      watch: watch.factory,
    });
    try {
      expect(watcher.watchedPath()).toBeNull();
      await vi.advanceTimersByTimeAsync(300);
      expect(watcher.watchedPath()).toBeNull();
      watch.failing.delete(history);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.watchedPath()).toBe(history);
      expect(changes).toHaveBeenCalled();
    } finally {
      watcher.close();
    }
  });

  it("memories: delete by id forgets the note; a card or a path outside memory is refused", async () => {
    const { tables, sources } = setup();
    await saveNote({ scope: "you", type: "fact", text: "Lives in Oslo." });
    const deps = fakeDeps({ tables, serviceHost: sources });
    const { client } = connectInProcess(deps);
    const { rows } = await client.db.memories.snapshot();
    expect(rows.map((row) => row.id)).toEqual(["you/lives-in-oslo.md"]);

    // Two tabs click the same row: both succeed, one note is gone.
    await Promise.all([
      client.db.memories.delete({ id: rows[0]!.id }),
      client.db.memories.delete({ id: rows[0]!.id }),
    ]);
    expect((await client.db.memories.snapshot()).rows).toEqual([]);

    const project = path.join(home, "memory", "projects", "shop");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "PROJECT.md"),
      "---\nname: project\ndescription: d\ntype: card\nupdated: 2026-11-09\nby: app\nproject: Shop\nkind: folder\nkey: /shop\n---\n\nWhat: Shop\n"
    );
    await expect(
      client.db.memories.delete({ id: "projects/shop/PROJECT.md" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      client.db.memories.delete({ id: "you/../../prefs.json" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fs.existsSync(path.join(project, "PROJECT.md"))).toBe(true);
  });

  it("bots-updated with no row change still publishes previews-changed", async () => {
    const { tables, bus } = setup();
    const deps = fakeDeps({ bus, tables });
    const { client } = connectInProcess(deps);
    tables.bots.snapshot();
    const events = await client.bots.events();
    await vi.waitFor(() => expect(bus.listenerCount()).toBeGreaterThan(2));
    // A transcript save for a bot chat: bots-updated, bots.json untouched.
    bus.dispatch({ type: "bots-updated", emittedAt: "" });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "previews-changed" },
    });
    await settle();
    expect(tables.bots.seq).toBe(0);
    await events.return();
  });

  it("prefs: an update sets nativeTheme.themeSource and echoes", async () => {
    const { tables, prefsStore, bus } = setup();
    const nativeTheme = {
      themeSource: "system" as const,
      shouldUseDarkColors: false,
    } as {
      themeSource: "system" | "light" | "dark";
      shouldUseDarkColors: boolean;
    };
    const refresh = vi.fn();
    const off = followPrefsTheme(prefsStore, nativeTheme, refresh);
    const { client } = connectInProcess(fakeDeps({ bus, tables }));

    const feed = await reader(tables.prefs);
    const position = await client.db.prefs.update({
      patch: { theme: "dark" },
    });
    expect(position).toEqual({ epoch: tables.prefs.epoch, seq: 1, key: "app" });
    expect(nativeTheme.themeSource).toBe("dark");
    expect(refresh).toHaveBeenCalledTimes(1);
    await expect(feed.next()).resolves.toMatchObject({
      seq: 1,
      changes: [{ type: "update", key: "app", value: { theme: "dark" } }],
    });
    // A write that changes nothing else leaves the theme alone.
    await client.db.prefs.update({ patch: { panes: { left: 240 } } });
    expect(refresh).toHaveBeenCalledTimes(1);
    off();
    await feed.close();
  });

  it("prefs: unknown keys are refused", async () => {
    const { tables, bus } = setup();
    const { client } = connectInProcess(fakeDeps({ bus, tables }));
    await expect(
      client.db.prefs.update({ patch: { nope: true } as never })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

/** Every batch `feed` publishes from now on, without a reader's baseline. */
const collect = <Row, Key extends string>(feed: TableFeed<Row, Key>) => {
  const batches: ChangeBatch<Row, Key>[] = [];
  const controller = new AbortController();
  const stream = feed.subscribe(controller.signal);
  const done = (async () => {
    try {
      for await (const batch of stream) batches.push(batch);
    } catch {
      // Aborted.
    }
  })();
  return {
    batches,
    close: async () => {
      controller.abort();
      await stream.return(undefined);
      await done;
    },
  };
};

const changesOf = <Row, Key extends string>(batches: ChangeBatch<Row, Key>[]) =>
  batches.flatMap((batch) => (batch.kind === "changes" ? batch.changes : []));

describe("DB table wiring (impl review r1)", { timeout: 20_000 }, () => {
  it("routineRuns alone: runs are created, settled and removed without a sessions reader", async () => {
    const { tables, sessions } = setup();
    const runs = await reader(tables.routineRuns);

    const run = sessions.create("ws-1", "job-1");
    await expect(runs.next()).resolves.toMatchObject({
      changes: [{ type: "insert", key: run.id, value: { outcome: "running" } }],
    });
    sessions.setRunOutcome(run.id, "completed");
    await expect(runs.next()).resolves.toMatchObject({
      changes: [
        { type: "update", key: run.id, value: { outcome: "completed" } },
      ],
    });
    sessions.remove("ws-1", run.id);
    await expect(runs.next()).resolves.toMatchObject({
      changes: [{ type: "delete", key: run.id }],
    });
    expect(tables.sessions.subscriberCount).toBe(0);
    await runs.close();
  });

  it("gitState: a delayed refresh never publishes the old workspace's changes under the new id", async () => {
    const workspaceService = new WorkspaceService();
    workspaceService.initialize();
    const dirA = fs.mkdtempSync(path.join(home, "ws-a-"));
    const dirB = fs.mkdtempSync(path.join(home, "ws-b-"));
    const added = await workspaceService.addWorkspace(dirA);
    const idA = (added as { workspaceId: string }).workspaceId;
    const reads: {
      path: string;
      resolve: (status: {
        changes: unknown[];
        available: boolean;
        message: string;
      }) => void;
    }[] = [];
    const change = (file: string) => ({
      path: file,
      status: "modified",
      stagedStatus: null,
      unstagedStatus: "modified",
    });
    const bus = new MainEventBus();
    const runtime = new WorkspaceRuntimeService({
      workspaceService,
      gitService: {
        readGitChanges: (dir: string) =>
          new Promise((resolve) => reads.push({ path: dir, resolve })),
      },
      fileTreeService: {
        invalidateCache: () => undefined,
        buildRootTree: async () => [],
      },
      emitEvent: (event: IpcEvent) => bus.dispatch(event),
    } as never);
    const sessions = new AgentSessionManagerService();
    tables = createTables({
      bus,
      sources: sourcesFor(sessions, {
        getMetadata: () => ({
          workspaces: workspaceService.getWorkspaces(),
          activeWorkspaceId: workspaceService.getActiveWorkspaceId(),
          materialIconsBasePath: null,
          lastUpdatedAt: "",
        }),
        onWorkspacesChanged: (listener) => workspaceService.onChanged(listener),
        getGitState: () => runtime.getGitState(),
        gitStateWorkspacePath: () => runtime.getSnapshot().workspacePath,
      }),
      prefsStore: new PrefsStore({ file: null }),
      watchMemories: false,
      routinesClockMs: null,
      artifactsPollMs: null,
    });
    const feed = collect(tables.gitState);

    // A's refresh is in flight when a new workspace becomes active.
    const refreshA = runtime.refreshAndEmit();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    const addedB = await workspaceService.addWorkspace(dirB);
    const idB = (addedB as { workspaceId: string }).workspaceId;
    expect(workspaceService.getActiveWorkspaceId()).toBe(idB);
    reads[0]!.resolve({
      changes: [change("a.txt")],
      available: true,
      message: "",
    });
    await refreshA;
    await settle();
    await settle();
    expect(runtime.getSnapshot().workspacePath).toBe(path.resolve(dirA));
    expect(tables.gitState.snapshot().rows).toEqual([]);

    // B's own refresh lands: now B has a row, with B's changes.
    const refreshB = runtime.refreshAndEmit();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    reads[1]!.resolve({
      changes: [change("b.txt")],
      available: true,
      message: "",
    });
    await refreshB;
    await settle();
    expect(tables.gitState.snapshot().rows).toMatchObject([
      { workspaceId: idB, gitChanges: [{ path: "b.txt" }] },
    ]);
    for (const entry of changesOf(feed.batches)) {
      if (entry.type === "delete") continue;
      const paths = entry.value.gitChanges.map((item) => item.path);
      if (entry.key === `${idB}:primary`) expect(paths).not.toContain("a.txt");
      else expect(entry.key).toBe(`${idA}:primary`);
    }
    await feed.close();
  });

  it("memory watcher re-arms a history replaced within one debounce", async () => {
    const watch = fakeWatch();
    const history = path.join(home, "memory", ".history");
    fs.mkdirSync(history, { recursive: true });
    const changes = vi.fn();
    const watcher = new MemoryWatcher({
      home,
      onChange: changes,
      debounceMs: 1,
      watch: watch.factory,
    });
    try {
      expect(watcher.watchedPath()).toBe(history);
      expect(watch.armedCount(history)).toBe(1);
      // Removed and recreated faster than the debounce; the directory reports
      // its own removal even when the inode is reused.
      fs.rmSync(history, { recursive: true });
      fs.mkdirSync(history);
      watch.emit(history, "rename", ".history");
      await vi.waitFor(() => expect(watch.armedCount(history)).toBe(2));
      expect(watch.live(history)).toBe(1);
      await vi.waitFor(() => expect(changes).toHaveBeenCalled());
      changes.mockClear();
      fs.writeFileSync(path.join(history, "2026-11.jsonl"), "{}\n");
      watch.emit(history, "change", "2026-11.jsonl");
      await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    } finally {
      watcher.close();
    }
  });

  it("memory watcher waits for a home that does not exist yet", async () => {
    const watch = fakeWatch();
    const later = path.join(home, "profile");
    const changes = vi.fn();
    const watcher = new MemoryWatcher({
      home: later,
      onChange: changes,
      debounceMs: 1,
      watch: watch.factory,
    });
    const history = path.join(later, "memory", ".history");
    try {
      expect(watcher.watchedPath()).toBe(home);
      fs.mkdirSync(history, { recursive: true });
      watch.emit(home, "rename", "profile");
      await vi.waitFor(() => expect(watcher.watchedPath()).toBe(history));
      changes.mockClear();
      fs.writeFileSync(path.join(history, "2026-11.jsonl"), "{}\n");
      watch.emit(history, "change", "2026-11.jsonl");
      await vi.waitFor(() => expect(changes).toHaveBeenCalled());
    } finally {
      watcher.close();
    }
  });

  it("artifacts: a file deleted or restored outside the app changes the table", async () => {
    const file = path.join(home, "report.md");
    fs.writeFileSync(file, "v1");
    stored.set("localCode.sessionArtifacts", [
      {
        id: `s1::${file}`,
        workspaceId: "ws-1",
        sessionId: "s1",
        kind: "file",
        title: "report.md",
        location: file,
        toolName: "write",
        createdAt: "2026-09-30T00:00:00.000Z",
        updatedAt: "2026-09-30T00:00:00.000Z",
      },
    ]);
    const artifacts = new SessionArtifactsService({
      resolveWorkspacePath: () => home,
      isWorkspaceRemote: () => false,
      onChanged: () => undefined,
    });
    artifacts.initialize(["ws-1"]);
    const { tables } = setup({
      sources: { listSessionArtifacts: () => artifacts.list() },
      artifactsPollMs: 20,
    });
    const feed = await reader(tables.artifacts);
    expect(tables.artifacts.snapshot().rows).toHaveLength(1);

    fs.rmSync(file);
    await expect(feed.next()).resolves.toMatchObject({
      changes: [{ type: "delete", key: `s1::${file}` }],
    });
    fs.writeFileSync(file, "v2");
    await expect(feed.next()).resolves.toMatchObject({
      changes: [{ type: "insert", key: `s1::${file}` }],
    });
    await feed.close();
  });

  it("bots-updated (a transcript save) re-diffs only bots", async () => {
    const listRoutines = vi.fn(() => routines);
    const listMemoriesSpy = vi.fn(memoryRows);
    const { tables, bus } = setup({
      sources: { listRoutines, listMemoryRows: listMemoriesSpy },
    });
    const routineFeed = await reader(tables.routines);
    const memoryFeed = await reader(tables.memories);
    listRoutines.mockClear();
    listMemoriesSpy.mockClear();
    bus.dispatch({ type: "bots-updated", emittedAt: "" });
    await settle();
    await settle();
    expect(listRoutines).not.toHaveBeenCalled();
    expect(listMemoriesSpy).not.toHaveBeenCalled();
    // A bots.json write reaches routines (they show bot names), not memory.
    createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    await settle();
    await settle();
    expect(listRoutines).toHaveBeenCalled();
    expect(listMemoriesSpy).not.toHaveBeenCalled();
    await routineFeed.close();
    await memoryFeed.close();
  });

  it("memory watchers and the routines clock run only while something reads them", async () => {
    const watch = vi.spyOn(fs, "watch");
    const intervals = vi.spyOn(globalThis, "setInterval");
    try {
      const { tables, bus } = setup({
        watchMemories: true,
        routinesClockMs: 60_000,
      });
      tables.memories.snapshot();
      tables.routines.snapshot();
      expect(watch).not.toHaveBeenCalled();
      expect(
        intervals.mock.calls.filter(([, ms]) => ms === 60_000)
      ).toHaveLength(0);

      const memories = await reader(tables.memories);
      expect(watch).toHaveBeenCalled();
      const watchers = watch.mock.results.map(
        (result) => result.value as fs.FSWatcher
      );
      const closed = watchers.map((watcher) => vi.spyOn(watcher, "close"));
      // memory.events is another reason to watch; both must leave.
      const off = bus.listenChannel("memory", () => undefined);
      await memories.close();
      await settle();
      expect(closed.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      off();
      expect(closed.every((spy) => spy.mock.calls.length > 0)).toBe(true);

      const routineFeed = await reader(tables.routines);
      expect(
        intervals.mock.calls.filter(([, ms]) => ms === 60_000)
      ).toHaveLength(1);
      await routineFeed.close();
    } finally {
      watch.mockRestore();
      intervals.mockRestore();
    }
  });

  it("routines: the cron store's own write hook re-diffs (createJob)", async () => {
    const { tables } = setup({
      sources: {
        listRoutines: () =>
          listJobs().map((job) => ({
            ...job,
            nextRunAt: null,
            webhookUrl: null,
            webhookPublicPending: false,
            botName: null,
          })),
        onRoutinesWritten: onCronStoreWrite,
      },
    });
    const feed = await reader(tables.routines);
    const job = createJob({
      prompt: "water the plants",
      schedule: "0 9 * * *",
    });
    await expect(feed.next()).resolves.toMatchObject({
      changes: [{ type: "insert", key: job.id }],
    });
    await feed.close();
  });

  it("workspaces: WorkspaceService's own hook re-diffs workspaces and gitState", async () => {
    const workspaceService = new WorkspaceService();
    workspaceService.initialize();
    const dirA = fs.mkdtempSync(path.join(home, "ws-a-"));
    const dirB = fs.mkdtempSync(path.join(home, "ws-b-"));
    await workspaceService.addWorkspace(dirA);
    const idB = (
      (await workspaceService.addWorkspace(dirB)) as { workspaceId: string }
    ).workspaceId;
    const git = { gitChanges: [], gitAvailable: true, gitStatusMessage: "" };
    const { tables } = setup({
      sources: {
        getMetadata: () => ({
          workspaces: workspaceService.getWorkspaces(),
          activeWorkspaceId: workspaceService.getActiveWorkspaceId(),
          materialIconsBasePath: null,
          lastUpdatedAt: "",
        }),
        onWorkspacesChanged: (listener) => workspaceService.onChanged(listener),
        getGitState: () => ({ ...git, lastUpdatedAt: "" }) as never,
        gitStateWorkspacePath: () =>
          workspaceService.getActiveWorkspace()?.path ?? null,
      },
    });
    const workspaces = await reader(tables.workspaces);
    const gitState = await reader(tables.gitState);
    const idA = workspaceService
      .getWorkspaces()
      .find((entry) => entry.id !== idB)!.id;
    workspaceService.switchWorkspace(idA);
    await expect(workspaces.next()).resolves.toMatchObject({
      changes: expect.arrayContaining([
        expect.objectContaining({
          key: idA,
          value: expect.objectContaining({ isActive: true }),
        }),
      ]),
    });
    await expect(gitState.next()).resolves.toMatchObject({
      changes: expect.arrayContaining([
        { type: "delete", key: `${idB}:primary` },
        expect.objectContaining({ type: "insert", key: `${idA}:primary` }),
      ]),
    });
    await workspaces.close();
    await gitState.close();
  });
});
