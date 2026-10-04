/** R3-T3,T4,T6,T7,T12,T15: real collections and the loader/action boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDb, type Db } from "#renderer/data/db";
import {
  FixtureDb,
  fixtureTransport,
} from "#renderer/data/fixture-db/fixture-db";
import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { CHECK_IN_PROMPT } from "#renderer/lib/bots/check-in";
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";

import { botAttention } from "./attention";
import { createBot, updateBot, deleteBot, duplicateName } from "./bot-actions";
import { loadBotChat, loadSenderChat } from "./loaders";
import { resetOpenChats } from "./open-chat";
import { botSessionsOf } from "./queries";
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
  const bot = fixtureBots()[0]!;
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
    const deps = { db, transport, load };
    expect(await loadBotChat(deps, bot.id, true)).toEqual({
      ready: false,
      botId: bot.id,
    });
    expect(openChat).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    await Promise.all([
      loadBotChat(deps, bot.id, false),
      loadBotChat(deps, bot.id, false),
    ]);
    expect(openChat).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("s-forever");
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
    const pending = loadSenderChat({ db, load }, bot.id, "s-run", false).then(
      () => {
        ready = true;
      }
    );
    const chat = loadBotChat(
      { db, transport: { client: { bots: { openChat } } } as never, load },
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
      (await loadSenderChat({ db, load }, bot.id, "s-run", false)).ready
    ).toBe(true);
    expect(
      (await loadSenderChat({ db, load }, bot.id, "s-sender", true)).ready
    ).toBe(false);
    await expect(
      loadSenderChat({ db, load }, bot.id, "s-forever", false)
    ).rejects.toBeDefined();
    await expect(
      loadSenderChat({ db, load }, "gone", "s-sender", false)
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
