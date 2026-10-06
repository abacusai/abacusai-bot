import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
/** R3-T3,T4,T6,T7,T12,T15: real collections and the loader/action boundary. */
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb, DbProvider, type Db } from "#renderer/data/db";
import {
  FixtureDb,
  fixtureTransport,
} from "#renderer/data/fixture-db/fixture-db";
import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { CHECK_IN_PROMPT } from "#renderer/lib/bots/check-in";

import { botAttention } from "./attention";
import { createBot, updateBot, deleteBot, duplicateName } from "./bot-actions";
import { loadBotChat, loadSenderChat } from "./loaders";
import { resetOpenChats } from "./open-chat";
import {
  botSessionsOf,
  useBotFiles,
  useBotMemories,
  useBotSessions,
  useCheckIn,
} from "./queries";
import { createUnreadStore } from "./unread-store";
let db: Db | undefined;
afterEach(async () => {
  db?.stop();
  if (db)
    await Promise.all(Object.values(db.collections).map((c) => c.cleanup()));
  resetOpenChats();
  vi.restoreAllMocks();
});
const setup = async (cold = false) => {
  const bot = { ...fixtureBots()[0]!, sessionId: "s-forever" };
  const forever = {
    ...fixtureSessions()[0]!,
    id: "s-forever",
    owner: {
      kind: "bot" as const,
      botId: bot.id,
      role: "forever" as const,
      key: "forever",
    },
  };
  const sender = {
    ...forever,
    id: "s-sender",
    owner: { ...forever.owner, role: "sender" as const },
  };
  const run = {
    ...forever,
    id: "s-run",
    owner: null,
    routineId: "routine-check",
  };
  const routine: RoutineRow = {
    id: "routine-check",
    name: "Check in",
    botId: bot.id,
    prompt: CHECK_IN_PROMPT,
    schedule: "0 9 * * 1-5",
    enabled: false,
    runAt: null,
    webhookToken: null,
    workspaceId: null,
    createdAt: 1,
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    webhookUrl: null,
    webhookPublicPending: false,
    botName: bot.name,
    recentRuns: [],
  };
  const feed = new FixtureDb({
    bots: [bot],
    sessions: [forever, sender, run],
    routines: [routine],
  });
  db = createDb(fixtureTransport(feed));
  if (!cold)
    await Promise.all([
      db.collections.bots.preload(),
      db.collections.sessions.preload(),
      db.collections.routines.preload(),
    ]);
  return { bot, forever, sender, run, routine, feed, db };
};
describe("bot loaders", () => {
  it("preloads without opening or hydrating, then deduplicates concurrent real opens", async () => {
    const { bot, db } = await setup();
    const openChat = vi.fn(async () => ({
      botId: bot.id,
      sessionId: "s-forever",
      workspaceId: "ws-1",
    }));
    const load = vi.fn(async () => {});
    const transport = { client: { bots: { openChat } } } as never;
    const warm = vi.fn();
    const ready = vi.fn(() => false);
    const deps = { db, transport, load, warm, ready };
    expect(await loadBotChat(deps, bot.id, true)).toEqual({
      ready: false,
      botId: bot.id,
    });
    expect(openChat).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(warm).not.toHaveBeenCalled();
    await Promise.all([
      loadBotChat(deps, bot.id, false),
      loadBotChat(deps, bot.id, false),
    ]);
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("s-forever");
    // Once opened, a hover warms the chat without asking main again or
    // building a session.
    load.mockClear();
    await loadBotChat(deps, bot.id, true);
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
    expect(warm).toHaveBeenCalledWith("s-forever");
    // A chat the runtime holds ready is the page itself: the click shows it
    // at once instead of the skeleton.
    warm.mockClear();
    ready.mockReturnValue(true);
    expect(await loadBotChat(deps, bot.id, true)).toEqual({
      ready: true,
      botId: bot.id,
      sessionId: "s-forever",
      workspaceId: "ws-1",
    });
    expect(warm).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
  it("cold snapshots block lookup and hydration until bots, sessions and routines are ready", async () => {
    const { bot, db, feed } = await setup(true);
    const releaseBots = feed.bots.holdSnapshot();
    const releaseSessions = feed.sessions.holdSnapshot();
    const releaseRoutines = feed.routines.holdSnapshot();
    const openChat = vi.fn(async () => ({
      botId: bot.id,
      sessionId: "s-forever",
      workspaceId: "ws-1",
    }));
    const load = vi.fn(async () => {});
    let ready = false;
    const pending = loadSenderChat(
      { db, load, warm: vi.fn(), ready: () => false },
      bot.id,
      "s-run",
      false
    ).then(() => {
      ready = true;
    });
    const chat = loadBotChat(
      {
        db,
        transport: { client: { bots: { openChat } } } as never,
        load,
        warm: vi.fn(),
        ready: () => false,
      },
      bot.id,
      false
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ready).toBe(false);
    expect(openChat).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    releaseBots();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openChat).not.toHaveBeenCalled();
    releaseSessions();
    await chat;
    expect(ready).toBe(false);
    expect(load).toHaveBeenCalledWith("s-forever");
    releaseRoutines();
    await pending;
    expect(load).toHaveBeenCalledWith("s-run");
  });
  it("loads check-in runs by routineId and refuses unrelated sessions and deleted bots", async () => {
    const { bot, db } = await setup();
    const load = vi.fn(async () => {});
    expect(
      (
        await loadSenderChat(
          { db, load, warm: vi.fn(), ready: () => false },
          bot.id,
          "s-run",
          false
        )
      ).ready
    ).toBe(true);
    expect(
      (
        await loadSenderChat(
          { db, load, warm: vi.fn(), ready: () => false },
          bot.id,
          "s-sender",
          true
        )
      ).ready
    ).toBe(false);
    await expect(
      loadSenderChat(
        { db, load, warm: vi.fn(), ready: () => false },
        bot.id,
        "s-forever",
        false
      )
    ).rejects.toBeDefined();
    await expect(
      loadSenderChat(
        { db, load, warm: vi.fn(), ready: () => false },
        "gone",
        "s-sender",
        false
      )
    ).rejects.toBeDefined();
  });
});
describe("actions over real collections", () => {
  it("creates and updates with echoes; equal values write nothing", async () => {
    const { db, bot } = await setup();
    const row = { ...bot, id: "bot-new", name: "New" };
    await createBot(db.collections.bots, row);
    expect(db.collections.bots.get(row.id)?.name).toBe("New");
    await updateBot(db.collections.bots, row.id, { name: "Changed" });
    expect(db.collections.bots.get(row.id)?.name).toBe("Changed");
    const update = vi.spyOn(db.collections.bots, "update");
    await updateBot(db.collections.bots, row.id, { name: "Changed" });
    expect(update).not.toHaveBeenCalled();
  });
  it("navigates before deletion and deleting a locally absent key is idempotent", async () => {
    const { db, bot } = await setup();
    const order: string[] = [];
    db.collections.bots.subscribeChanges((changes) => {
      if (changes.some((c) => c.type === "delete")) order.push("delete");
    });
    await deleteBot(
      {
        bots: db.collections.bots,
        leave: () => {
          order.push("leave");
        },
      },
      bot.id
    );
    expect(order[0]).toBe("leave");
    expect(db.collections.bots.has(bot.id)).toBe(false);
    await expect(
      deleteBot({ bots: db.collections.bots }, bot.id)
    ).resolves.toBeUndefined();
  });
  it("keeps unique duplicate names within the limit", () => {
    expect(
      duplicateName("A".repeat(30), new Set(["A".repeat(28) + " 2"]))
    ).toBe("A".repeat(28) + " 3");
  });
});
describe("R3-T6 the bot's rows, filtered in the live query", () => {
  it("joins sessions by owner.botId and the check-in's runs, files by session, memories by bot and scope", async () => {
    const { bot, forever, sender, run, feed, db } = await setup();
    // Oldest first: the run, then the sender chat, then the forever chat.
    feed.sessions.upsert({ ...run, createdAt: "2026-01-01T00:00:01.000Z" });
    feed.sessions.upsert({ ...sender, createdAt: "2026-01-01T00:00:02.000Z" });
    feed.sessions.upsert({ ...forever, createdAt: "2026-01-01T00:00:03.000Z" });
    feed.sessions.upsert({
      ...fixtureSessions()[0]!,
      id: "s-other",
      owner: null,
      routineId: null,
    });
    const artifact = (id: string, sessionId: string, updatedAt: number) =>
      ({ id, sessionId, updatedAt }) as never;
    feed.artifacts.upsert(artifact("a-old", "s-forever", 1));
    feed.artifacts.upsert(artifact("a-new", "s-run", 2));
    feed.artifacts.upsert(artifact("a-other", "s-other", 3));
    const memory = (id: string, scope: string, botId: string | null) =>
      ({ id, scope, botId, index: id.length, entry: id }) as never;
    feed.memories.upsert(memory("m-bot", "bot", bot.id));
    feed.memories.upsert(memory("m-global", "global", bot.id));
    feed.memories.upsert(memory("m-else", "bot", "another-bot"));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(DbProvider, { value: db }, children);
    const { result, unmount } = renderHook(
      () => {
        const sessions = useBotSessions(bot.id);
        return {
          sessions: sessions.map((s) => s.id),
          files: useBotFiles(bot.id).map((a) => a.id),
          memories: useBotMemories(bot.id).map((m) => m.id),
        };
      },
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current).toEqual({
        sessions: ["s-run", "s-sender", "s-forever"],
        files: ["a-new", "a-old"],
        memories: ["m-bot"],
      })
    );
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("keeps one query across new sessions and check-ins: the rows change, never back to empty", async () => {
    const { bot, forever, routine, feed, db } = await setup();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(DbProvider, { value: db }, children);
    const seen: string[][] = [];
    const { result, unmount } = renderHook(
      () => {
        const ids = useBotSessions(bot.id).map((s) => s.id);
        seen.push(ids);
        return { ids, checkIn: useCheckIn(bot.id)?.id };
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.ids).toHaveLength(3));
    const first = seen.findIndex((ids) => ids.length > 0);
    feed.sessions.upsert({ ...forever, id: "s-later" });
    await waitFor(() => expect(result.current.ids).toContain("s-later"));
    // An older exact-prompt routine is the check-in now: its runs join, the
    // old one's leave, in the same query.
    feed.routines.upsert({ ...routine, id: "routine-older", createdAt: 0 });
    feed.sessions.upsert({
      ...forever,
      id: "s-older-run",
      owner: null,
      routineId: "routine-older",
    });
    await waitFor(() => expect(result.current.checkIn).toBe("routine-older"));
    await waitFor(() =>
      expect(result.current.ids).toEqual(
        expect.arrayContaining(["s-older-run", "s-forever", "s-later"])
      )
    );
    expect(result.current.ids).not.toContain("s-run");
    expect(seen.slice(first).every((ids) => ids.length > 0)).toBe(true);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("joins a large bot's files by session id in bounded time", async () => {
    const { bot, forever } = await setup();
    const SESSIONS = 2_000;
    const ARTIFACTS = 20_000;
    const feed = new FixtureDb({
      bots: [bot],
      sessions: Array.from({ length: SESSIONS }, (_, i) => ({
        ...forever,
        id: `s-${i}`,
      })),
      artifacts: Array.from(
        { length: ARTIFACTS },
        (_, i) =>
          ({
            id: `a-${i}`,
            // Every other artifact belongs to another bot's session.
            sessionId: i % 2 === 0 ? `s-${i % SESSIONS}` : `elsewhere-${i}`,
            updatedAt: i,
          }) as never
      ),
    });
    const large = createDb(fixtureTransport(feed));
    await Promise.all([
      large.collections.sessions.preload(),
      large.collections.routines.preload(),
      large.collections.artifacts.preload(),
    ]);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(DbProvider, { value: large }, children);
    const started = performance.now();
    const { result, unmount } = renderHook(() => useBotFiles(bot.id), {
      wrapper,
    });
    await waitFor(() => expect(result.current).toHaveLength(ARTIFACTS / 2), {
      timeout: 20_000,
    });
    const built = performance.now() - started;
    const before = performance.now();
    feed.artifacts.upsert({
      id: "a-new",
      sessionId: "s-7",
      updatedAt: ARTIFACTS,
    } as never);
    await waitFor(() => expect(result.current[0]?.id).toBe("a-new"));
    const updated = performance.now() - before;
    // Measured ~300 ms to build and ~50 ms per change here; without the
    // `artifacts.sessionId` index the build scans artifacts per session
    // (~7.5 s). Generous bounds: this guards the order of growth.
    expect(built).toBeLessThan(2_500);
    expect(updated).toBeLessThan(500);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    large.stop();
  }, 60_000);
});
describe("attention and unread", () => {
  it("joins ownerless check-in runs; each waiting session contributes independently", async () => {
    const { bot, forever, sender, run } = await setup();
    expect(
      botSessionsOf([forever, sender, run], bot.id, "routine-check").map(
        (s) => s.id
      )
    ).toEqual(["s-forever", "s-sender", "s-run"]);
    const waiting = {
      ...sender,
      turn: {
        phase: "waiting_permission" as const,
        isBusy: true,
        updatedAt: new Date().toISOString(),
      },
    };
    expect(
      botAttention({
        sessions: [forever, waiting],
        permissions: {
          [forever.id]: { count: 0, firstTitle: null, oldestAt: 0 },
        },
        connectorAsks: { [waiting.id]: 2 },
        checkInRoutineId: "routine-check",
        unread: true,
        checkIn: { enabled: false },
        runningTool: null,
      })
    ).toMatchObject({ kind: "needs-you", count: 3 });
  });
  it.each([
    ["routine", true, false],
    ["working", false, true],
    ["paused", false, false],
  ] as const)("prioritizes %s", async (kind, routineBusy, foreverBusy) => {
    const { forever, run } = await setup();
    expect(
      botAttention({
        sessions: [
          {
            ...forever,
            turn: {
              phase: foreverBusy ? "streaming" : "idle",
              isBusy: foreverBusy,
              updatedAt: "",
            },
          },
          {
            ...run,
            turn: {
              phase: routineBusy ? "streaming" : "idle",
              isBusy: routineBusy,
              updatedAt: "",
            },
          },
        ],
        permissions: {},
        connectorAsks: {},
        checkInRoutineId: "routine-check",
        unread: false,
        checkIn: { enabled: false },
        runningTool: null,
      }).kind
    ).toBe(kind);
  });
  it("unread is explicit and does not persist into a fresh document store", () => {
    const unread = createUnreadStore();
    unread.mark("b");
    expect(unread.has("b")).toBe(true);
    expect(createUnreadStore().has("b")).toBe(false);
    unread.clear("b");
    expect(unread.has("b")).toBe(false);
  });
});
