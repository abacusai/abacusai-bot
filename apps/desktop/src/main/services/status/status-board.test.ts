/**
 * The status board: the one place that decides whether the user hears that
 * something long-lived stopped, and how. Real board, real status.json in a
 * temp dir, real English words; only the clock and the senders are fakes.
 *
 * Each of these was silent before: a hold or a quiet pause wrote no line and
 * told nobody, a link lost on an older build never said so, and missed runs
 * across a sleep reached only an in-app toast someone had to be looking at.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { channelWords } from "../messaging/channel-words";
import {
  LANE_FLAP_COOLDOWN_MS,
  LANE_WAITING_NOTIFY_MS,
  LANE_WAITING_SHOW_MS,
  STATUS_BATCH_MS,
  STATUS_MERGE_MS,
  STATUS_NATIVE_DAILY_CAP,
  StatusBoard,
  type ChatNotice,
  type StatusNotice,
} from "./status-board";

let dir: string;
const english = await channelWords("en-US");

const world = () => ({
  native: [] as StatusNotice[],
  chat: [] as ChatNotice[],
  log: [] as string[],
  focused: false,
  quiet: false,
});

const boardFor = (w: ReturnType<typeof world>) =>
  new StatusBoard({
    file: () => path.join(dir, "status.json"),
    log: (line) => w.log.push(line),
    words: async () => english,
    notify: (notice) => w.native.push(notice),
    windowFocused: () => w.focused,
    tellChat: async (notice) => {
      w.chat.push(notice);
      return true;
    },
    quiet: () => w.quiet,
  });

/** Past the batch, so what was reported has gone out. */
const settle = () => vi.advanceTimersByTimeAsync(STATUS_BATCH_MS + 10);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-board-"));
  vi.useFakeTimers({ now: new Date(2026, 10, 9, 12, 0) });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("telling", () => {
  it("tells a change once, logs it, and lists it in-app", async () => {
    const w = world();
    const board = boardFor(w);
    const detail = {
      name: "Inbox digest",
      routineId: "r1",
      platform: "telegram",
    };
    board.report("routine:r1", "paused-by-app", "quiet", detail);
    board.report("routine:r1", "paused-by-app", "quiet", detail);
    await settle();
    expect(w.native.map((n) => n.title)).toEqual(["Inbox digest paused"]);
    expect(w.chat).toHaveLength(1);
    expect(w.chat[0]!.platform).toBe("telegram");
    expect(w.log).toEqual([
      "[status] routine:r1 running -> paused-by-app (quiet)",
    ]);
    expect(board.list().map((item) => item.key)).toEqual(["routine:r1"]);
  });

  it("is not told again after a restart, but is when the state changed", async () => {
    const w = world();
    boardFor(w).report("routine:r1", "paused-by-app", "quiet", { name: "A" });
    await settle();
    expect(w.native).toHaveLength(1);

    const again = boardFor(w);
    again.reconcile(() =>
      again.report("routine:r1", "paused-by-app", "quiet", { name: "A" })
    );
    await settle();
    expect(w.native).toHaveLength(1);

    again.report("routine:r1", "paused-by-app", "failing", { name: "A" });
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS);
    expect(w.native).toHaveLength(2);
  });

  it("tells at launch a stop an older build never told (a lane parked as lost)", async () => {
    const w = world();
    const board = boardFor(w);
    board.reconcile(() =>
      board.report("lane:whatsapp", "stopped-needs-user", "link-lost", {
        platform: "whatsapp",
      })
    );
    await settle();
    expect(w.native.map((n) => n.title)).toEqual(["WhatsApp is disconnected"]);
    // Its own lane is dead: the chat line goes through another one.
    expect(w.chat[0]!.avoid).toBe("whatsapp");
  });

  it("drops untold what nobody re-reports at launch (a deleted routine)", async () => {
    const w = world();
    boardFor(w).report("routine:gone", "paused-by-app", "quiet", { name: "G" });
    await settle();
    const board = boardFor(w);
    board.reconcile(() => {});
    board.report("routine:gone", "running", "ok");
    await settle();
    // No "back on" line for a stop the board no longer holds.
    expect(w.chat).toHaveLength(1);
    const stored = JSON.parse(
      fs.readFileSync(path.join(dir, "status.json"), "utf8")
    ) as { told: Record<string, unknown> };
    expect(stored.told).toEqual({});
  });

  it("says a told stop is over where it was said, and only there", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("routine:r1", "paused-by-app", "link-lost", {
      name: "Standup",
      platform: "telegram",
    });
    await settle();
    board.clear("routine:r1", ["link-lost"]);
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS);
    expect(w.chat.map((c) => c.text)).toEqual([
      "Standup paused\nIts runs wait until Telegram is connected again. The missed run is made up then.",
      "Standup is running again.",
    ]);
    expect(w.native).toHaveLength(1);
    expect(board.list()).toEqual([]);
  });

  it("clears only a stop its reporter owns", () => {
    const w = world();
    const board = boardFor(w);
    board.report("routine:r1", "paused-by-app", "link-lost", { name: "A" });
    board.clear("routine:r1", ["network", "slept"]);
    expect(board.get("routine:r1")?.reason).toBe("link-lost");
  });
});

describe("the policy table", () => {
  it.each([
    ["paused-by-app", "quiet", "routine:r", 1, 1],
    ["stopped-needs-user", "login-not-finished", "lane:telegram", 1, 1],
    ["missed", "slept", "routine:r", 1, 0],
    ["stopped", "interrupted", "run:s1", 0, 0],
    ["waiting", "network", "routine:r", 0, 0],
  ] as const)(
    "%s (%s): %i native, %i chat",
    async (state, reason, key, native, chat) => {
      const w = world();
      boardFor(w).report(key, state, reason, { name: "N", count: 2 });
      await settle();
      expect(w.native).toHaveLength(native);
      expect(w.chat).toHaveLength(chat);
    }
  );

  it("shows a retrying lane after a while, and notifies once after an hour", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("lane:discord", "waiting", "retrying", {
      platform: "discord",
    });
    expect(board.list()).toEqual([]);
    expect(board.visible("lane:discord")).toBe(false);
    await vi.advanceTimersByTimeAsync(LANE_WAITING_SHOW_MS);
    expect(board.list()).toHaveLength(1);
    expect(w.native).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LANE_WAITING_NOTIFY_MS);
    expect(w.native.map((n) => n.title)).toEqual(["Discord can't connect"]);
    await vi.advanceTimersByTimeAsync(5 * LANE_WAITING_NOTIFY_MS);
    expect(w.native).toHaveLength(1);
  });

  it("leaves native to the window when it is focused", async () => {
    const w = world();
    w.focused = true;
    boardFor(w).report("routine:r", "paused-by-app", "quiet", { name: "A" });
    await settle();
    expect(w.native).toHaveLength(0);
    expect(w.chat).toHaveLength(1);
  });
});

describe("no spam", () => {
  it("sums a wake's missed routines into one notice", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("routine:a", "missed", "slept", {
      name: "A",
      count: 2,
      madeUp: 1,
    });
    board.report("routine:b", "missed", "slept", {
      name: "B",
      count: 1,
      madeUp: 0,
    });
    board.report("routine:c", "missed", "slept", {
      name: "C",
      count: 2,
      madeUp: 1,
    });
    await settle();
    expect(w.native).toEqual([
      expect.objectContaining({
        title: "Routines missed runs",
        body: "3 routines missed 5 runs while the computer slept or the app was closed. 2 made up.",
      }),
    ]);
  });

  it("merges what comes within a minute of the last notice", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("routine:a", "paused-by-app", "quiet", { name: "A" });
    await settle();
    board.report("routine:b", "paused-by-app", "failing", { name: "B" });
    board.report("lane:telegram", "stopped-needs-user", "link-lost", {
      platform: "telegram",
    });
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS - 5_000);
    expect(w.native).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.native.map((n) => n.title)).toEqual([
      "A paused",
      "2 things stopped",
    ]);
  });

  it("holds native and chat in quiet hours and sends them after; in-app at once", async () => {
    const w = world();
    w.quiet = true;
    const board = boardFor(w);
    board.report("routine:a", "paused-by-app", "quiet", { name: "A" });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(board.list()).toHaveLength(1);
    expect(w.native).toHaveLength(0);
    expect(w.chat).toHaveLength(0);
    w.quiet = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(w.native).toHaveLength(1);
    expect(w.chat).toHaveLength(1);
  });

  it("an owed notice survives a quit and goes on the next launch", async () => {
    const w = world();
    w.quiet = true;
    boardFor(w).report("routine:a", "paused-by-app", "quiet", { name: "A" });
    w.quiet = false;
    const next = boardFor(w);
    next.reconcile(() =>
      next.report("routine:a", "paused-by-app", "quiet", { name: "A" })
    );
    await settle();
    expect(w.native).toHaveLength(1);
  });

  it(`caps native notices at ${STATUS_NATIVE_DAILY_CAP} a day; in-app keeps every one`, async () => {
    const w = world();
    const board = boardFor(w);
    for (let i = 0; i < STATUS_NATIVE_DAILY_CAP + 2; i++) {
      board.report(`routine:${i}`, "paused-by-app", "quiet", { name: `R${i}` });
      await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    }
    expect(w.native).toHaveLength(STATUS_NATIVE_DAILY_CAP);
    expect(board.list()).toHaveLength(STATUS_NATIVE_DAILY_CAP + 2);
    expect(w.log).toContain("[status] daily notice cap reached; in-app only");
  });
});

describe("routineStopped (the credits governor's entry)", () => {
  it.each([
    ["network-hold", "waiting", "network"],
    ["credit-hold", "stopped-needs-user", "credits-out"],
    ["quiet-pause", "paused-by-app", "quiet"],
    ["failing-pause", "paused-by-app", "failing"],
    ["link-down", "paused-by-app", "link-lost"],
    ["signed-out", "stopped-needs-user", "signed-out"],
  ] as const)("%s is %s (%s)", (cause, state, reason) => {
    const board = boardFor(world());
    board.routineStopped("r", cause, { name: "R" });
    expect(board.get("routine:r")).toMatchObject({ state, reason });
  });

  it("the user's own pause, or a resume, clears it untold", async () => {
    const w = world();
    const board = boardFor(w);
    board.routineStopped("r", "network-hold", { name: "R" });
    board.routineStopped("r", "user-pause");
    await settle();
    expect(board.get("routine:r")).toBeNull();
    expect(w.native).toHaveLength(0);
    expect(w.log).toContain("[status] routine:r paused by the user");
  });
});

describe("review follow-ups", () => {
  it("tells a new missed finding again, but not the same one twice", async () => {
    const w = world();
    const board = boardFor(w);
    const missed = (at: number, count: number) =>
      board.report("routine:a", "missed", "slept", { name: "A", count, at });
    missed(1, 2);
    await settle();
    missed(1, 2);
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    expect(w.native).toHaveLength(1);
    // The next wake's finding is news.
    missed(2, 3);
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    expect(w.native).toHaveLength(2);
  });

  it("says a lane is back on that lane, and its loss through another", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("lane:whatsapp", "stopped-needs-user", "link-lost", {
      platform: "whatsapp",
    });
    await settle();
    expect(w.chat[0]).toMatchObject({ avoid: "whatsapp", platform: null });
    board.clear("lane:whatsapp", ["link-lost"]);
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    expect(w.chat[1]).toMatchObject({ platform: "whatsapp", avoid: null });
  });

  it("a routine whose app is off is told through another app", async () => {
    const w = world();
    boardFor(w).report("routine:r", "paused-by-app", "lane-off", {
      name: "R",
      platform: "whatsapp",
    });
    await settle();
    expect(w.chat[0]).toMatchObject({ platform: null, avoid: "whatsapp" });
  });

  it("gives one telling one chat id, whatever retries it", async () => {
    const w = world();
    const board = boardFor(w);
    board.report("routine:r", "paused-by-app", "quiet", { name: "R" });
    await settle();
    expect(w.chat[0]!.id).toMatch(/^status:routine:r:paused-by-app:\d+$/);
  });

  it("tells a flapping lane once per cooldown", async () => {
    const w = world();
    const board = boardFor(w);
    const down = () =>
      board.report("lane:discord", "stopped-needs-user", "needs-user", {
        platform: "discord",
      });
    down();
    await settle();
    board.clear("lane:discord", ["needs-user"]);
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    down();
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    expect(w.native).toHaveLength(1);
    // Still on the list in-app.
    expect(board.get("lane:discord")?.state).toBe("stopped-needs-user");
    board.clear("lane:discord", ["needs-user"]);
    await vi.advanceTimersByTimeAsync(LANE_FLAP_COOLDOWN_MS);
    down();
    await vi.advanceTimersByTimeAsync(STATUS_MERGE_MS + STATUS_BATCH_MS);
    expect(w.native).toHaveLength(2);
  });
});
