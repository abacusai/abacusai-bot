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

import { ConflictError } from "#shared/conflict";
import type { ChangeBatch } from "#shared/contract/rows";
import type { RoutineListItem } from "#shared/routines";

import { createTables, type Tables } from ".";
import {
  forgetEntryAt,
  listMemories,
} from "../../services/agent-tools/memory-store";
import {
  forgetBotMemoryEntry,
  listBotMemories,
} from "../../services/bots/bot-memory-store";
import {
  botDir,
  createBot,
  listBots,
  onBotStoreWrite,
  removeBot,
  updateBot,
} from "../../services/bots/bot-store";
import { PrefsStore } from "../../services/config/prefs-store";
import { AgentSessionManagerService } from "../../services/session/agent-session-manager-service";
import { followPrefsTheme } from "../../startup-theme";
import { MainEventBus } from "../event-bus";
import { connectInProcess, fakeDeps } from "../testing";
import { MemoryWatchers } from "./memories";
import type { TableSources } from "./sources";
import type { TableFeed } from "./table-feed";

let home: string;
let tables: Tables | null = null;
let routines: RoutineListItem[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "db-tables-"));
  process.env.ABACUSAI_BOT_HOME = home;
  stored.clear();
  routines = [];
});

afterEach(() => {
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
  listMemories,
  listBotMemories,
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
  botHome: () => home,
  ...overrides,
});

const setup = (
  options: { watchMemories?: boolean; prefsStore?: PrefsStore } = {}
) => {
  const bus = new MainEventBus();
  const sessions = new AgentSessionManagerService();
  sessions.initialize(["ws-1"]);
  const sources = sourcesFor(sessions);
  const prefsStore =
    options.prefsStore ??
    new PrefsStore({ file: path.join(home, "prefs.json") });
  tables = createTables({
    bus,
    sources,
    prefsStore,
    watchMemories: options.watchMemories ?? false,
    routinesClockMs: null,
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

describe("DB table wiring (B-T3)", () => {
  it("bots: create, update and delete through the store are one batch each", async () => {
    const { tables } = setup();
    const bots = await reader(tables.bots);

    const bot = createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    expect(bot.id).toBe("bot-ada");
    await expect(bots.next()).resolves.toMatchObject({
      seq: 1,
      changes: [{ type: "insert", key: "bot-ada" }],
    });

    updateBot(bot.id, { name: "Ada L." });
    await expect(bots.next()).resolves.toMatchObject({
      seq: 2,
      changes: [{ type: "update", value: { name: "Ada L." } }],
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
        runs: Array.from({ length: 25 }, (_, i) => ({
          at: 100 - i,
          trigger: "schedule" as const,
          result: `run ${i}`,
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
    expect(row.recentRuns).toHaveLength(20);
    expect((row.recentRuns as { at: number }[])[0]).toMatchObject({
      at: 100,
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

  it("memories: an external write to memories/ arrives within 500 ms", async () => {
    const { tables, bus } = setup({ watchMemories: true });
    const feed = await reader(tables.memories);
    let notices = 0;
    bus.listenChannel("memory", () => {
      notices += 1;
    });

    fs.mkdirSync(path.join(home, "memories"));
    // Let the watchers re-arm on the new directory.
    await vi.waitFor(() => expect(notices).toBeGreaterThan(0), {
      timeout: 1_000,
    });
    const started = Date.now();
    fs.writeFileSync(
      path.join(home, "memories", "MEMORY.md"),
      "likes tea\n§\nlives in Oslo"
    );
    const batch = await feed.next(500);
    expect(Date.now() - started).toBeLessThan(500);
    expect(batch).toMatchObject({
      changes: [
        {
          type: "insert",
          value: {
            scope: "global",
            target: "memory",
            entry: "likes tea",
            index: 0,
          },
        },
        { type: "insert", value: { entry: "lives in Oslo", index: 1 } },
      ],
    });
    await feed.close();
  });

  it("memories: a bot's daily notes fire memory.events; a removed bot drops its watchers", async () => {
    const { tables, bus } = setup({ watchMemories: true });
    tables.memories.snapshot();
    const bot = createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    let notices = 0;
    bus.listenChannel("memory", () => {
      notices += 1;
    });

    fs.mkdirSync(botDir(bot.id), { recursive: true });
    await vi.waitFor(() => expect(notices).toBeGreaterThan(0), {
      timeout: 1_000,
    });
    const before = notices;
    fs.mkdirSync(path.join(botDir(bot.id), "memory"));
    await vi.waitFor(() => expect(notices).toBeGreaterThan(before), {
      timeout: 1_000,
    });
    const afterDir = notices;
    fs.writeFileSync(
      path.join(botDir(bot.id), "memory", "2026-09-30.md"),
      "notes"
    );
    await vi.waitFor(() => expect(notices).toBeGreaterThan(afterDir), {
      timeout: 1_000,
    });
    expect(listBotMemories()).toMatchObject([{ botId: bot.id, noteDays: 1 }]);
  });

  it("memory watchers follow bot directories in and out", async () => {
    const changes = vi.fn();
    const watchers = new MemoryWatchers({ home, onChange: changes });
    try {
      const bots = path.join(home, "bots");
      const dir = path.join(bots, "bot-x");
      fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
      await vi.waitFor(
        () =>
          expect(watchers.watchedPaths()).toEqual(
            [home, bots, dir, path.join(dir, "memory")].sort()
          ),
        { timeout: 1_000 }
      );
      fs.rmSync(dir, { recursive: true, force: true });
      await vi.waitFor(
        () => expect(watchers.watchedPaths()).toEqual([home, bots].sort()),
        { timeout: 1_000 }
      );
      expect(changes).toHaveBeenCalled();
    } finally {
      watchers.close();
    }
    expect(watchers.watchedPaths()).toEqual([]);
  });

  it("memories: a duplicate-entry delete race gives the second click CONFLICT", async () => {
    const { tables, sources } = setup();
    fs.mkdirSync(path.join(home, "memories"));
    fs.writeFileSync(path.join(home, "memories", "REMEMBER.md"), "a\n§\na");
    const deps = fakeDeps({
      tables,
      serviceHost: {
        ...sources,
        forgetMemory: async (
          request: { target: "remember"; index: number; entry: string },
          occurrences?: number
        ) => {
          const result = await forgetEntryAt(
            request.target,
            request.index,
            request.entry,
            occurrences
          );
          if (!result.ok) throw new ConflictError(result.message);
          return listMemories();
        },
      },
    });
    const { client } = connectInProcess(deps);
    const { rows } = await client.db.memories.snapshot();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ index: 0, entry: "a", occurrences: 2 });
    expect(rows[0]!.id.endsWith(":0")).toBe(true);
    expect(rows[1]!.id.endsWith(":1")).toBe(true);

    // Two tabs click the same row.
    const clicked = rows[0]!;
    const input = {
      id: clicked.id,
      scope: clicked.scope,
      target: clicked.target,
      botId: clicked.botId,
      index: clicked.index,
      entry: clicked.entry,
      occurrences: clicked.occurrences,
    };
    const results = await Promise.allSettled([
      client.db.memories.delete(input),
      client.db.memories.delete(input),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const rejected = results.find((r) => r.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: "CONFLICT",
      defined: true,
    });
    expect(listMemories().remember).toEqual(["a"]);
    // The survivor is now the only copy.
    expect((await client.db.memories.snapshot()).rows).toMatchObject([
      { entry: "a", occurrences: 1 },
    ]);
  });

  it("bot memories: the same stale-click guard", () => {
    createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    fs.mkdirSync(botDir("bot-ada"), { recursive: true });
    fs.writeFileSync(path.join(botDir("bot-ada"), "MEMORY.md"), "- a\n- a\n");
    forgetBotMemoryEntry("bot-ada", 0, "a", 2);
    expect(() => forgetBotMemoryEntry("bot-ada", 0, "a", 2)).toThrow(
      ConflictError
    );
    expect(listBotMemories()[0]!.entries).toEqual(["a"]);
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
