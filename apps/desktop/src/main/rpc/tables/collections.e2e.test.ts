/**
 * B-T4: every table end to end. Main's real router and table feeds over a
 * real MessageChannel (with main's flow control), and the renderer's real
 * collections (renderer-next/data/db) in the same process. Per table: the
 * snapshot, a live change, a reset (truncate and reload) and, where the
 * table has one, a mutation that round-trips, with `awaitReceived` settling
 * inside the handler and `awaitApplied` after it.
 *
 * The collection modules are the renderer's, compiled by its own tsconfig,
 * so they are imported by path at run time and typed here by what is used.
 */
import { createCollection, type Collection } from "@tanstack/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "#shared/bots";
import type {
  AgentSessionListItem,
  GitStateSnapshot,
  IpcEvent,
  MemorySnapshot,
  SessionArtifact,
  WorkspaceListItem,
} from "#shared/contracts";
import type { RoutineListItem } from "#shared/routines";

import { createTables, type TableName, type Tables } from ".";
import { PrefsStore } from "../../services/config/prefs-store";
import { MainEventBus } from "../event-bus";
import { connectInProcess, fakeDeps, type TestClient } from "../testing";

const DB_TABLES_MODULE = "../../../renderer-next/data/db/tables";

type Position = { epoch: string; seq: number };

interface Utils {
  awaitReceived(pos: Position): Promise<void>;
  awaitApplied(pos: Position): Promise<void>;
  status(): { epoch: string | null; receivedSeq: number; appliedSeq: number };
}

type Factory = (
  transport: () => Promise<{ client: TestClient }>,
  overrides?: {
    retryDelayMs?: (attempt: number) => number;
    startSync?: boolean;
  }
) => Record<string, unknown> & { utils: Utils };

const loadFactories = async (): Promise<Record<string, Factory>> =>
  (await import(/* @vite-ignore */ DB_TABLES_MODULE)) as Record<
    string,
    Factory
  >;

const listeners = <T extends (...args: never[]) => void>() => {
  const set = new Set<T>();
  return {
    add: (listener: T) => {
      set.add(listener);
      return () => set.delete(listener) as unknown as void;
    },
    fire: () => {
      for (const listener of set) (listener as () => void)();
    },
  };
};

const session = (
  id: string,
  over: Partial<AgentSessionListItem> = {}
): AgentSessionListItem => ({
  id,
  workspaceId: "ws-1",
  label: "Untitled",
  conversationId: null,
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  status: "stopped",
  agentStatus: "idle" as AgentSessionListItem["agentStatus"],
  model: null,
  mode: null,
  worktreeId: null,
  worktreePath: null,
  worktreeBranch: null,
  routineId: null,
  runOutcome: null,
  runTrigger: null,
  editorFor: null,
  botOwned: false,
  owner: null,
  ...over,
});

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  title: "",
  description: "d",
  persona: "",
  avatarColor: "#a855f7",
  avatarShape: "circle",
  workspaceId: null,
  sessionId: null,
  channel: null,
  model: null,
  createdAt: 1,
  updatedAt: 1,
});

const routine = (id: string, name: string): RoutineListItem => ({
  id,
  name,
  schedule: null,
  runAt: null,
  webhookToken: null,
  prompt: "p",
  workspaceId: null,
  botId: null,
  enabled: true,
  createdAt: 1,
  lastRunAt: null,
  lastResult: null,
  runs: [],
  nextRunAt: null,
  webhookUrl: null,
  webhookPublicPending: false,
  botName: null,
});

const artifact = (id: string, title: string): SessionArtifact => ({
  id,
  workspaceId: "ws-1",
  sessionId: "s1",
  kind: "file",
  title,
  location: `/tmp/${title}`,
  toolName: "write",
  createdAt: "",
  updatedAt: "",
});

const workspace = (id: string, label: string): WorkspaceListItem => ({
  id,
  label,
  description: `/w/${id}`,
  status: "idle",
  path: `/w/${id}`,
  isRemote: false,
});

/** Main's state as plain arrays, and a service host over them. */
const world = () => {
  const state = {
    sessions: [session("s1"), session("r1", { routineId: "job-1" })],
    bots: [bot("b1", "One")],
    routines: [routine("job-1", "Daily")],
    artifacts: [artifact("a1", "one.txt")],
    memories: { remember: ["tea"], memory: [], user: [] } as MemorySnapshot,
    workspaces: [workspace("ws-1", "Home"), workspace("ws-2", "Work")],
    active: "ws-1" as string | null,
    git: {
      gitChanges: [],
      gitAvailable: true,
      gitStatusMessage: "clean",
      lastUpdatedAt: "",
    } as GitStateSnapshot,
  };
  const hooks = {
    sessions: listeners(),
    bots: listeners(),
    routines: listeners(),
    workspaces: listeners(),
  };
  const serviceHost = {
    listAllAgentSessions: () => state.sessions,
    listSessionTurnStates: () => [],
    onSessionsChanged: hooks.sessions.add,
    listBots: () => state.bots,
    onBotsWritten: hooks.bots.add,
    listRoutines: () => state.routines,
    onRoutinesWritten: hooks.routines.add,
    listSessionArtifacts: () => state.artifacts,
    listMemories: () => state.memories,
    listBotMemories: () => [],
    getMetadata: () => ({
      workspaces: state.workspaces,
      activeWorkspaceId: state.active,
      materialIconsBasePath: null,
      lastUpdatedAt: new Date().toISOString(),
    }),
    onWorkspacesChanged: hooks.workspaces.add,
    // Stamped on every read, as main's is.
    getGitState: () => ({
      ...state.git,
      lastUpdatedAt: new Date().toISOString(),
    }),
    botHome: () => "/nowhere",
    // Mutations: the store normalises, then its hook fires.
    updateAgentSessionLabel: (_ws: string, id: string, label: string) => {
      state.sessions = state.sessions.map((row) =>
        row.id === id ? { ...row, label: label.trim() } : row
      );
      hooks.sessions.fire();
      return true;
    },
    createBot: (input: { name: string }, id: string) => {
      const created = { ...bot(id, input.name.trim()), updatedAt: 2 };
      state.bots = [...state.bots, created];
      hooks.bots.fire();
      return created;
    },
    createRoutine: (input: { name?: string }, id: string) => {
      const created = routine(id, (input.name ?? "").trim() || "Derived");
      state.routines = [...state.routines, created];
      hooks.routines.fire();
      return created;
    },
    forgetMemory: async (request: { index: number; entry: string }) => {
      state.memories = {
        ...state.memories,
        remember: state.memories.remember.filter(
          (entry, index) =>
            !(index === request.index && entry === request.entry)
        ),
      };
      return state.memories;
    },
    updateWorkspaceLabel: async (id: string, label: string) => {
      state.workspaces = state.workspaces.map((row) =>
        row.id === id ? { ...row, label } : row
      );
      hooks.workspaces.fire();
      return { success: true };
    },
  };
  return { state, hooks, serviceHost };
};

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const connect = async () => {
  const { state, hooks, serviceHost } = world();
  const bus = new MainEventBus();
  const tables: Tables = createTables({
    bus,
    sources: serviceHost,
    prefsStore: new PrefsStore({ file: null }),
    watchMemories: false,
    routinesClockMs: null,
  });
  cleanups.push(() => tables.dispose());
  const connection = connectInProcess(fakeDeps({ bus, tables, serviceHost }));
  cleanups.push(() => connection.closeClient());
  const factories = await loadFactories();
  const collectionFor = (name: TableName) => {
    const factory = factories[`${name}CollectionOptions`];
    if (factory == null) throw new Error(`no options for ${name}`);
    const collection = createCollection(
      factory(async () => ({ client: connection.client }), {
        retryDelayMs: () => 0,
        startSync: false,
      }) as never
    ) as unknown as Collection<Record<string, any>, string> & { utils: Utils };
    cleanups.push(() => collection.cleanup());
    return collection;
  };
  const emit = (event: Pick<IpcEvent, "type">) =>
    bus.dispatch({ ...event, emittedAt: "" } as IpcEvent);
  return {
    state,
    hooks,
    tables,
    bus,
    collectionFor,
    emit,
    client: connection.client,
  };
};

type Env = Awaited<ReturnType<typeof connect>>;

interface TableCase {
  name: TableName;
  /** The keys main holds now. */
  keys: (env: Env) => string[];
  /** Change main and fire the table's trigger; returns the changed key. */
  change: (env: Env) => {
    key: string;
    check: (row: Record<string, unknown>) => void;
  };
  /** Change main without a trigger (only a reset reveals it). */
  silently: (env: Env) => void;
}

const CASES: TableCase[] = [
  {
    name: "sessions",
    keys: ({ state }) => state.sessions.map((row) => row.id),
    change: ({ state, emit }) => {
      state.sessions = [...state.sessions, session("s2", { label: "Two" })];
      emit({ type: "local-cli-session-created" });
      return { key: "s2", check: (row) => expect(row.label).toBe("Two") };
    },
    silently: ({ state }) => {
      state.sessions = state.sessions.filter((row) => row.id !== "s1");
    },
  },
  {
    name: "bots",
    keys: ({ state }) => state.bots.map((row) => row.id),
    change: ({ state, hooks }) => {
      state.bots = state.bots.map((row) => ({ ...row, name: "Uno" }));
      hooks.bots.fire();
      return { key: "b1", check: (row) => expect(row.name).toBe("Uno") };
    },
    silently: ({ state }) => {
      state.bots = [];
    },
  },
  {
    name: "routines",
    keys: ({ state }) => state.routines.map((row) => row.id),
    change: ({ state, emit }) => {
      state.routines = [...state.routines, routine("job-2", "Weekly")];
      emit({ type: "cronjobs-updated" });
      return {
        key: "job-2",
        check: (row) => {
          expect(row.name).toBe("Weekly");
          expect(row.recentRuns).toEqual([]);
        },
      };
    },
    silently: ({ state }) => {
      state.routines = [];
    },
  },
  {
    name: "routineRuns",
    keys: ({ state }) =>
      state.sessions
        .filter((row) => row.routineId != null)
        .map((row) => row.id),
    change: ({ state, hooks }) => {
      state.sessions = state.sessions.map((row) =>
        row.id === "r1" ? { ...row, runOutcome: "completed" } : row
      );
      hooks.sessions.fire();
      return {
        key: "r1",
        check: (row) => expect(row.outcome).toBe("completed"),
      };
    },
    silently: ({ state }) => {
      state.sessions = state.sessions.filter((row) => row.id !== "r1");
    },
  },
  {
    name: "artifacts",
    keys: ({ state }) => state.artifacts.map((row) => row.id),
    change: ({ state, emit }) => {
      state.artifacts = [...state.artifacts, artifact("a2", "two.txt")];
      emit({ type: "session-artifacts-updated" });
      return { key: "a2", check: (row) => expect(row.title).toBe("two.txt") };
    },
    silently: ({ state }) => {
      state.artifacts = [];
    },
  },
  {
    name: "memories",
    keys: ({ tables }) => tables.memories.snapshot().rows.map((row) => row.id),
    change: ({ state, tables }) => {
      state.memories = { ...state.memories, user: ["lives in Oslo"] };
      // The watchers' notify.
      tables.memories.notify();
      const key = tables.memories
        .snapshot()
        .rows.find((row) => row.target === "user")!.id;
      return { key, check: (row) => expect(row.entry).toBe("lives in Oslo") };
    },
    silently: ({ state }) => {
      state.memories = { remember: [], memory: [], user: [] };
    },
  },
  {
    name: "workspaces",
    keys: ({ state }) => state.workspaces.map((row) => row.id),
    change: ({ state, emit }) => {
      state.active = "ws-2";
      emit({ type: "metadata-updated" });
      return { key: "ws-2", check: (row) => expect(row.isActive).toBe(true) };
    },
    silently: ({ state }) => {
      state.workspaces = state.workspaces.slice(0, 1);
    },
  },
  {
    name: "gitState",
    keys: ({ state }) => (state.active == null ? [] : [state.active]),
    change: ({ state, emit }) => {
      state.git = { ...state.git, gitStatusMessage: "1 change" };
      emit({ type: "git-state-updated" });
      return {
        key: "ws-1",
        check: (row) => expect(row.gitStatusMessage).toBe("1 change"),
      };
    },
    silently: ({ state }) => {
      state.active = null;
    },
  },
  {
    name: "prefs",
    keys: () => ["app"],
    change: ({ tables }) => {
      tables.prefsStore.update({ theme: "dark" });
      return { key: "app", check: (row) => expect(row.theme).toBe("dark") };
    },
    silently: () => {
      // The row always exists; a reset reloads it unchanged.
    },
  },
];

describe("DB tables end to end (B-T4)", () => {
  for (const table of CASES) {
    it(`${table.name}: snapshot, live change, reset`, async () => {
      const env = await connect();
      const collection = env.collectionFor(table.name);
      await collection.preload();
      expect(collection.status).toBe("ready");
      expect(Array.from(collection.keys()).sort()).toEqual(
        table.keys(env).sort()
      );

      const { key, check } = table.change(env);
      await vi.waitFor(() => {
        const row = collection.get(key) as Record<string, unknown> | undefined;
        expect(row).toBeDefined();
        check(row!);
      });

      // A change nothing announced, then main says "your copy is invalid".
      table.silently(env);
      const truncated = vi.fn();
      collection.on("truncate", truncated);
      env.tables[table.name].reset();
      // The reset's seq is the reload's snapshot seq.
      await vi.waitFor(() =>
        expect(collection.utils.status().receivedSeq).toBe(
          env.tables[table.name].seq
        )
      );
      await vi.waitFor(() =>
        expect(Array.from(collection.keys()).sort()).toEqual(
          table.keys(env).sort()
        )
      );
      expect(truncated).toHaveBeenCalled();
      expect(env.tables[table.name].subscriberCount).toBe(1);
    });
  }

  it("the gitState stamp is not a change", async () => {
    const env = await connect();
    const collection = env.collectionFor("gitState");
    await collection.preload();
    env.emit({ type: "git-state-updated" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(env.tables.gitState.seq).toBe(0);
  });

  const mutation = async (
    name: TableName,
    act: (collection: ReturnType<Env["collectionFor"]>) => {
      isPersisted: { promise: Promise<unknown> };
    }
  ) => {
    const env = await connect();
    const collection = env.collectionFor(name);
    await collection.preload();
    const feed = env.tables[name];
    const received = vi.fn();
    const wrap = collection.utils.awaitReceived.bind(collection.utils);
    collection.utils.awaitReceived = async (pos) => {
      await wrap(pos);
      // Inside the handler: its own transaction is still persisting.
      received({ ...pos, applied: collection.utils.status().appliedSeq });
    };
    const tx = act(collection);
    await tx.isPersisted.promise;
    expect(received).toHaveBeenCalledTimes(1);
    const pos = received.mock.calls[0]![0] as Position & { applied: number };
    expect(pos).toMatchObject({ epoch: feed.epoch, seq: feed.seq });
    expect(pos.applied).toBeLessThan(pos.seq);
    await collection.utils.awaitApplied(pos);
    expect(collection.utils.status().appliedSeq).toBeGreaterThanOrEqual(
      pos.seq
    );
    return { env, collection };
  };

  it("sessions: a rename round-trips, normalised by main", async () => {
    const { collection } = await mutation("sessions", (sessions) =>
      sessions.update("s1", (draft) => {
        draft.label = "  Renamed  ";
      })
    );
    expect(collection.get("s1")).toMatchObject({ label: "Renamed" });
  });

  it("bots: an insert keeps the client id", async () => {
    const { collection, env } = await mutation("bots", (bots) =>
      bots.insert({ ...bot("bot-client", "  Two  ") })
    );
    expect(collection.get("bot-client")).toMatchObject({
      name: "Two",
      updatedAt: 2,
    });
    expect(env.state.bots.map((row) => row.id)).toContain("bot-client");
  });

  it("routines: an insert keeps the client id", async () => {
    const { collection } = await mutation("routines", (routines) =>
      routines.insert({ ...routine("job-client", "") })
    );
    expect(collection.get("job-client")).toMatchObject({ name: "Derived" });
  });

  it("memories: a delete sends the row the user clicked", async () => {
    const env = await connect();
    const collection = env.collectionFor("memories");
    await collection.preload();
    const [key] = Array.from(collection.keys());
    await collection.delete(key as string).isPersisted.promise;
    expect(collection.size).toBe(0);
    expect(env.state.memories.remember).toEqual([]);
  });

  it("workspaces: a rename round-trips", async () => {
    const { collection } = await mutation("workspaces", (workspaces) =>
      workspaces.update("ws-2", (draft) => {
        draft.label = "Office";
      })
    );
    expect(collection.get("ws-2")).toMatchObject({ label: "Office" });
  });

  it("prefs: an update round-trips and marks the field the user's", async () => {
    const { collection, env } = await mutation("prefs", (prefs) =>
      prefs.update("app", (draft) => {
        draft.panes = { sidebar: 300 };
      })
    );
    expect(collection.get("app")).toMatchObject({ panes: { sidebar: 300 } });
    expect(env.tables.prefsStore.provenance().panes).toBe("user");
  });

  it("prefs: updatePrefs makes an explicit choice of the current value the user's", async () => {
    const env = await connect();
    const collection = env.collectionFor("prefs");
    await collection.preload();
    const { createUpdatePrefs } = (await loadFactories()) as unknown as {
      createUpdatePrefs: (
        collection: unknown,
        transport: () => Promise<{ client: TestClient }>
      ) => (patch: Record<string, unknown>) => Promise<void>;
    };
    // TanStack drops an assignment of the current value: nothing is sent.
    await collection.update("app", (draft) => {
      draft.theme = "system";
    }).isPersisted.promise;
    expect(env.tables.prefsStore.provenance().theme).toBe("default");

    const updatePrefs = createUpdatePrefs(collection, async () => ({
      client: env.client,
    }));
    await updatePrefs({ theme: "system" });
    expect(env.tables.prefsStore.provenance().theme).toBe("user");
    // So a legacy import no longer overwrites it.
    env.tables.prefsStore.importLegacy({ theme: "dark" });
    expect(env.tables.prefsStore.get().theme).toBe("system");

    // A visible change goes through the collection optimistically and echoes.
    await updatePrefs({ sidebar: { pinned: false } });
    expect(collection.get("app")).toMatchObject({
      sidebar: { pinned: false, openSection: null },
    });
    expect(env.tables.prefsStore.provenance()).toMatchObject({
      "sidebar.pinned": "user",
      "sidebar.openSection": "default",
    });
  });

  it("prefs: a collection update of one leaf marks only that leaf", async () => {
    const env = await connect();
    const collection = env.collectionFor("prefs");
    await collection.preload();
    await collection.update("app", (draft) => {
      draft.sidebar.openSection = "bots";
    }).isPersisted.promise;
    expect(env.tables.prefsStore.provenance()).toMatchObject({
      "sidebar.openSection": "user",
      "sidebar.pinned": "default",
    });
  });

  it("a read-only field is refused and rolled back, not silently dropped", async () => {
    const env = await connect();
    const collection = env.collectionFor("sessions");
    await collection.preload();
    const before = collection.get("s1");
    const tx = collection.update("s1", (draft) => {
      draft.runOutcome = "failed";
    });
    await expect(tx.isPersisted.promise).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(collection.get("s1")).toEqual(before);
  });

  it("read-only tables refuse writes", async () => {
    const env = await connect();
    for (const name of ["routineRuns", "artifacts", "gitState"] as const) {
      const collection = env.collectionFor(name);
      await collection.preload();
      expect(() => collection.insert({ id: "x" } as never)).toThrow();
    }
  });
});
