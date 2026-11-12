import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { channelWords } from "../messaging/channel-words";
import {
  WorkWaiting,
  type WorkWaitingNotice,
  type WorkWaitingPlace,
  workWaitingMetadata,
  workWaitingOffer,
} from "./work-waiting";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

const setup = (names: Record<string, string | null> = {}, file?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-waiting-"));
  dirs.push(dir);
  const state = file ?? path.join(dir, "work-waiting.json");
  const clock = { now: 0, quiet: false, busy: false, enabled: true };
  const account: {
    free: { credits: number; until: string } | null;
    asked: number;
  } = { free: null, asked: 0 };
  const shown: Array<Omit<WorkWaitingNotice, "dedupeKey">> = [];
  const clicks: Array<(action: boolean) => void> = [];
  const funnel: string[] = [];
  const deps = {
    file: () => state,
    quiet: () => clock.quiet,
    enabled: () => clock.enabled,
    busy: () => clock.busy,
    nameOf: (place: WorkWaitingPlace) => {
      const key =
        place.kind === "channel"
          ? place.channelId
          : place.kind === "routine"
            ? place.routineId
            : place.sessionId;
      return key in names ? { name: names[key] ?? null } : null;
    },
    words: () => channelWords("en-US"),
    freeCredits: async () => {
      account.asked += 1;
      return account.free;
    },
    show: (notice: WorkWaitingNotice, clicked: (action: boolean) => void) => {
      const { dedupeKey: _key, ...rest } = notice;
      shown.push(rest);
      clicks.push(clicked);
    },
    funnel: (step: string, detail: string) => funnel.push(`${step} ${detail}`),
    now: () => clock.now,
  };
  const waiting = new WorkWaiting(deps);
  /** A fresh instance over the same file: the app relaunched. */
  const relaunch = () => new WorkWaiting(deps);
  return { waiting, relaunch, clock, account, shown, clicks, funnel, state };
};

const session = (sessionId: string): WorkWaitingPlace => ({
  kind: "session",
  sessionId,
});

const REPLY =
  "Your game is live on your computer.\n\n**Want me to add a high-score board next?**";

describe("work waiting: what each notice says", () => {
  it.each([
    {
      name: "a result whose reply offered a next step",
      ending: "site" as const,
      task: "Add a high-score board",
      reply: REPLY,
      body: "Want me to add a high-score board next?",
      action: { label: "Open next step", draft: "Add a high-score board" },
    },
    {
      name: "a result with a next step but no question",
      ending: "site" as const,
      task: "Add a high-score board",
      reply: "Done.",
      body: "Next step: Add a high-score board",
      action: { label: "Open next step", draft: "Add a high-score board" },
    },
    {
      name: "a result without one",
      ending: "file" as const,
      task: null,
      reply: REPLY,
      body: "Your file is ready. Open it to keep going.",
    },
    {
      name: "a question for the user",
      ending: "question" as const,
      task: null,
      reply: null,
      body: "I asked you something, and I'm waiting for your answer.",
    },
    {
      name: "a turn that stopped partway",
      ending: "unfinished" as const,
      task: null,
      reply: null,
      body: "It stopped partway. Open it and I'll go on from there.",
    },
    {
      name: "a plain reply",
      ending: "chat" as const,
      task: null,
      reply: null,
      body: "Pick up right where you left off.",
    },
  ])(
    "names the project and says what was left: $name",
    async ({ ending, task, reply, body, action }) => {
      const t = setup({ s1: "Neon Runner" });
      t.waiting.userWrote(session("s1"));
      t.clock.now = 60_000;
      t.waiting.turnEnded("s1", ending, task, reply);
      t.clock.now = 60_000 + 3 * HOUR;
      expect(await t.waiting.tick()).toBe(false);
      t.clock.now = 60_000 + 3.5 * HOUR;
      expect(await t.waiting.tick()).toBe(true);
      expect(t.shown).toEqual([
        {
          title: "“Neon Runner” is waiting for you",
          body,
          place: session("s1"),
          ...(action == null ? {} : { action }),
        },
      ]);
    }
  );

  it("words a chat with no title yet without one, and cuts a long title", async () => {
    const t = setup({ s1: null, s2: "x".repeat(80) });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    t.waiting.userWrote(session("s2"));
    t.clock.now = 8 * HOUR;
    await t.waiting.tick();
    expect(t.shown.map((s) => s.title)).toEqual([
      "Your work is waiting",
      `“${"x".repeat(39)}…” is waiting for you`,
    ]);
  });

  it("never repeats a title or a body within one absence", async () => {
    const t = setup({ s1: "Neon Runner", s2: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.waiting.turnEnded("s1", "site", "Add a high-score board", REPLY);
    t.waiting.userWrote(session("s2"));
    t.waiting.turnEnded("s2", "unfinished", null, null);
    for (let hour = 0; hour <= 24 * 9; hour += 0.25) {
      t.clock.now = hour * HOUR;
      await t.waiting.tick();
    }
    expect(t.shown.map(({ title, body }) => [title, body])).toEqual([
      [
        "“Trip plan” is waiting for you",
        "It stopped partway. Open it and I'll go on from there.",
      ],
      [
        "Pick up “Trip plan” where you left off",
        "It's partly done, and I can finish it when you're back.",
      ],
      [
        "“Trip plan” is ready when you are",
        "It stopped partway. Open it and I'll go on from there.",
      ],
      [
        "Still thinking about “Trip plan”?",
        "It's partly done, and I can finish it when you're back.",
      ],
    ]);
    const next = setup({ s1: "Neon Runner" });
    next.waiting.userWrote(session("s1"));
    next.waiting.turnEnded("s1", "site", "Add a high-score board", REPLY);
    for (let hour = 0; hour <= 24 * 9; hour += 0.25) {
      next.clock.now = hour * HOUR;
      await next.waiting.tick();
    }
    expect(next.shown.map((s) => s.body)).toEqual([
      "Want me to add a high-score board next?",
      "Up next, when you're ready: Add a high-score board",
      "Want me to add a high-score board next?",
      "Up next, when you're ready: Add a high-score board",
    ]);
  });
});

describe("work waiting: one absence at a time, from wherever the user left off", () => {
  it("shows at most four notices an absence, 16 hours apart, the last on day seven", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    const due: number[] = [];
    for (let hour = 0; hour <= 24 * 10; hour += 0.25) {
      t.clock.now = hour * HOUR;
      if (await t.waiting.tick()) due.push(hour);
    }
    expect(due).toEqual([3.5, 20, 72, 168]);
    expect(t.funnel).toEqual([
      "work_waiting_shown 1_chat_plain",
      "work_waiting_shown 2_chat_plain",
      "work_waiting_shown 3_chat_plain",
      "work_waiting_shown 4_chat_plain",
    ]);
  });

  it("brings day seven up at the next launch within the eighth day, never after", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    for (const hour of [4, 20, 72]) {
      t.clock.now = hour * HOUR;
      await t.waiting.tick();
    }
    t.clock.now = 7.5 * DAY;
    expect(await t.relaunch().tick()).toBe(true);
    const late = setup({ s1: "Trip plan" });
    late.waiting.userWrote(session("s1"));
    late.clock.now = 4 * HOUR;
    await late.waiting.tick();
    late.clock.now = 8 * DAY;
    expect(await late.relaunch().tick()).toBe(false);
  });

  it("tells a free account on day seven the free credits left and until when", async () => {
    // One absence that starts on Mar 1 and reaches day seven.
    const start = Date.parse("2030-03-01T00:00:00Z");
    const u = setup({ s1: "Trip plan" });
    u.account.free = { credits: 1234.6, until: "2030-03-21T00:00:00Z" };
    u.clock.now = start;
    u.waiting.userWrote(session("s1"));
    u.waiting.turnEnded("s1", "site", "Add a high-score board", REPLY);
    for (const hour of [4, 20, 72, 168]) {
      u.clock.now = start + hour * HOUR;
      await u.waiting.tick();
    }
    expect(u.account.asked).toBe(1);
    expect(u.shown.at(-1)).toEqual({
      title: "Still thinking about “Trip plan”?",
      body: "You have 1,234 free credits left, until March 21.",
      place: session("s1"),
      action: { label: "Open next step", draft: "Add a high-score board" },
    });
    expect(u.funnel.at(-1)).toBe("work_waiting_shown 4_site_task_credits");
  });

  it.each([
    { name: "a paid or unknown account", free: null },
    {
      name: "free credits that already ended",
      free: { credits: 500, until: "2030-03-02T00:00:00Z" },
    },
    {
      name: "no free credits left",
      free: { credits: 0, until: "2030-03-21T00:00:00Z" },
    },
  ])("keeps day seven's own words for $name", async ({ free }) => {
    const start = Date.parse("2030-03-01T00:00:00Z");
    const t = setup({ s1: "Trip plan" });
    t.account.free = free;
    t.clock.now = start;
    t.waiting.userWrote(session("s1"));
    for (const hour of [4, 20, 72, 168]) {
      t.clock.now = start + hour * HOUR;
      await t.waiting.tick();
    }
    expect(t.shown.at(-1)?.body).toBe("Everything is just where you left it.");
    expect(t.funnel.at(-1)).toBe("work_waiting_shown 4_chat_plain");
  });

  it("starts again each time the user comes back and leaves", async () => {
    const t = setup({ s1: "Trip plan", s2: "Budget" });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 4 * HOUR;
    expect(await t.waiting.tick()).toBe(true);
    // Back the next day, in another chat, then gone again.
    t.clock.now = 30 * HOUR;
    t.waiting.userWrote(session("s2"));
    t.waiting.turnEnded("s2", "question", null);
    t.clock.now = 33 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.now = 34 * HOUR;
    expect(await t.waiting.tick()).toBe(true);
    expect(t.shown.map((s) => s.title)).toEqual([
      "“Trip plan” is waiting for you",
      "“Budget” is waiting for you",
    ]);
  });

  it("ignores a turn ending in another chat than the one the user left", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.waiting.turnEnded("other", "site", "Something else", REPLY);
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    expect(t.shown[0]?.body).toBe("Pick up right where you left off.");
    expect(t.shown[0]?.action).toBeUndefined();
  });

  it("counts a channel's absence from its last word, and opens the channel", async () => {
    const t = setup({ c1: "Launch team" });
    t.waiting.userWrote({ kind: "channel", channelId: "c1" });
    t.clock.now = 2 * HOUR;
    t.waiting.channelSpoke("c1");
    t.clock.now = 5 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.now = 5.5 * HOUR;
    expect(await t.waiting.tick()).toBe(true);
    expect(t.shown[0]).toEqual({
      title: "“Launch team” is waiting for you",
      body: "Pick up right where you left off.",
      place: { kind: "channel", channelId: "c1" },
    });
  });

  it("brings up a routine that found something while the user was away, over a plain reply only", async () => {
    const t = setup({ s1: "Trip plan", r1: "Price watch" });
    t.waiting.userWrote(session("s1"));
    t.waiting.turnEnded("s1", "question", null);
    t.waiting.routineRan("r1", "run1");
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    t.clock.now = 30 * HOUR;
    t.waiting.userWrote(session("s1"));
    t.waiting.routineRan("r1", "run2");
    t.clock.now = 34 * HOUR;
    await t.waiting.tick();
    expect(t.shown).toEqual([
      {
        title: "“Trip plan” is waiting for you",
        body: "I asked you something, and I'm waiting for your answer.",
        place: session("s1"),
      },
      {
        title: "“Price watch” is waiting for you",
        body: "Your routine has new results for you.",
        place: { kind: "routine", routineId: "r1", sessionId: "run2" },
      },
    ]);
  });

  it("ends the absence on a click, counted per notice and per button", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.waiting.turnEnded("s1", "site", "Add a high-score board", REPLY);
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    t.clicks[0]!(true);
    t.clock.now = 30 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    t.waiting.userWrote(session("s1"));
    t.clock.now = 34 * HOUR;
    await t.waiting.tick();
    t.clicks[1]!(false);
    t.waiting.userWrote(session("deleted"));
    t.clock.now = 40 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    expect(t.funnel).toEqual([
      "work_waiting_shown 1_site_task",
      "work_waiting_clicked 1_site_task_next",
      "work_waiting_shown 1_chat_plain",
      "work_waiting_clicked 1_chat_plain",
    ]);
  });

  it("holds while project reminders are off, during quiet hours and a running turn, and survives a relaunch", async () => {
    const t = setup({ s1: null });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 4 * HOUR;
    t.clock.enabled = false;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.enabled = true;
    t.clock.quiet = true;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.quiet = false;
    t.clock.busy = true;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.busy = false;
    expect(t.funnel).toEqual([]);
    expect(await t.relaunch().tick()).toBe(true);
    expect(t.shown[0]?.body).toBe("Pick up right where you left off.");
  });

  it("reads a record written before offers were kept", async () => {
    const t = setup({ s1: "Trip plan" });
    fs.writeFileSync(
      t.state,
      JSON.stringify({
        place: session("s1"),
        ending: "site",
        task: "Add my photos",
        leftAt: 0,
        shownAt: [],
        done: false,
      })
    );
    t.clock.now = 4 * HOUR;
    expect(await t.relaunch().tick()).toBe(true);
    expect(t.shown[0]?.body).toBe("Next step: Add my photos");
  });

  it("opens a chat as itself, a channel and a routine run at their pages", () => {
    expect(workWaitingMetadata(session("s1"))).toEqual({ sessionId: "s1" });
    expect(workWaitingMetadata({ kind: "channel", channelId: "c1" })).toEqual({
      kind: "channel",
      channelId: "c1",
    });
    expect(
      workWaitingMetadata({
        kind: "routine",
        routineId: "r1",
        sessionId: "run",
      })
    ).toEqual({
      kind: "routine",
      routineId: "r1",
      sessionId: "run",
    });
  });
});

describe("work waiting: the offer a result's reply ended on", () => {
  it.each([
    [REPLY, "Want me to add a high-score board next?"],
    [
      "Done. Your page is up. Shall I put your real projects in?",
      "Shall I put your real projects in?",
    ],
    [
      "- Want me to [add a form](http://x) next?",
      "Want me to add a form next?",
    ],
    [
      "サイトができました。次にスコア表を追加しますか？",
      "次にスコア表を追加しますか？",
    ],
    ["Your page is ready.", null],
    [`Want me to ${"really ".repeat(30)}go on?`, null],
    [null, null],
  ])("%j reads as %j", (reply, offer) => {
    expect(workWaitingOffer(reply)).toBe(offer);
  });
});
