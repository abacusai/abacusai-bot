import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkWaiting,
  type WorkWaitingPlace,
  workWaitingMetadata,
} from "./work-waiting";

const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

const WORDS: Record<string, string> = {
  "workWaiting.title": "Your work is waiting",
  "workWaiting.site": "Your site is ready.",
  "workWaiting.file": "Your file is ready.",
  "workWaiting.question": "{{name}} is waiting for your answer.",
  "workWaiting.questionPlain": "Your chat is waiting for your answer.",
  "workWaiting.unfinished": "{{name}} stopped partway.",
  "workWaiting.unfinishedPlain": "Your task stopped partway.",
  "workWaiting.chat": "Pick up where you left off in {{name}}.",
  "workWaiting.chatPlain": "Pick up where you left off.",
  "workWaiting.routine": "{{name}} has new results for you.",
  "workWaiting.routinePlain": "Your routine has new results for you.",
};

const setup = (names: Record<string, string | null> = {}, file?: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-waiting-"));
  dirs.push(dir);
  const state = file ?? path.join(dir, "work-waiting.json");
  const clock = { now: 0, quiet: false, busy: false };
  const shown: Array<{ body: string; place: WorkWaitingPlace }> = [];
  const clicks: Array<() => void> = [];
  const funnel: string[] = [];
  const deps = {
    file: () => state,
    quiet: () => clock.quiet,
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
    words:
      async () => (key: string, values?: Record<string, string | number>) =>
        (WORDS[key] ?? key).replace("{{name}}", String(values?.name ?? "")),
    show: (
      notice: { body: string; place: WorkWaitingPlace },
      clicked: () => void
    ) => {
      shown.push({ body: notice.body, place: notice.place });
      clicks.push(clicked);
    },
    funnel: (step: string, detail: string) => funnel.push(`${step} ${detail}`),
    now: () => clock.now,
  };
  const waiting = new WorkWaiting(deps);
  /** A fresh instance over the same file: the app relaunched. */
  const relaunch = () => new WorkWaiting(deps);
  return { waiting, relaunch, clock, shown, clicks, funnel };
};

const session = (sessionId: string): WorkWaitingPlace => ({
  kind: "session",
  sessionId,
});

describe("work waiting: one absence at a time, from wherever the user left off", () => {
  it.each([
    {
      name: "a result with a next step",
      ending: "site" as const,
      task: "Add my photos",
      body: "Add my photos",
    },
    {
      name: "a result without one",
      ending: "file" as const,
      task: null,
      body: "Your file is ready.",
    },
    {
      name: "a question for the user",
      ending: "question" as const,
      task: null,
      body: "Trip plan is waiting for your answer.",
    },
    {
      name: "a turn that stopped partway",
      ending: "unfinished" as const,
      task: null,
      body: "Trip plan stopped partway.",
    },
    {
      name: "a plain reply",
      ending: "chat" as const,
      task: null,
      body: "Pick up where you left off in Trip plan.",
    },
  ])("says what was left: $name", async ({ ending, task, body }) => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 60_000;
    t.waiting.turnEnded("s1", ending, task);
    t.clock.now = 60_000 + 3 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.now = 60_000 + 3.5 * HOUR;
    expect(await t.waiting.tick()).toBe(true);
    expect(t.shown.map((s) => s.body)).toEqual([body]);
  });

  it("shows at most three notices an absence, 16 hours apart, then waits for the user", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    const due: number[] = [];
    for (let hour = 0; hour <= 24 * 8; hour += 0.25) {
      t.clock.now = hour * HOUR;
      if (await t.waiting.tick()) due.push(hour);
    }
    expect(due).toEqual([3.5, 20, 72]);
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
    expect(t.shown.map((s) => s.body)).toEqual([
      "Pick up where you left off in Trip plan.",
      "Budget is waiting for your answer.",
    ]);
  });

  it("ignores a turn ending in another chat than the one the user left", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.waiting.turnEnded("other", "site", "Something else");
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    expect(t.shown[0]?.body).toBe("Pick up where you left off in Trip plan.");
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
      body: "Pick up where you left off in Launch team.",
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
      { body: "Trip plan is waiting for your answer.", place: session("s1") },
      {
        body: "Price watch has new results for you.",
        place: { kind: "routine", routineId: "r1", sessionId: "run2" },
      },
    ]);
  });

  it("ends the absence on a click, and when the place is gone", async () => {
    const t = setup({ s1: "Trip plan" });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 4 * HOUR;
    await t.waiting.tick();
    t.clicks[0]!();
    t.clock.now = 30 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    t.waiting.userWrote(session("deleted"));
    t.clock.now = 34 * HOUR;
    expect(await t.waiting.tick()).toBe(false);
    expect(t.funnel).toEqual([
      "work_waiting_shown 1_chat_plain",
      "work_waiting_clicked 1",
    ]);
  });

  it("holds during quiet hours and a running turn, and survives a relaunch", async () => {
    const t = setup({ s1: null });
    t.waiting.userWrote(session("s1"));
    t.clock.now = 4 * HOUR;
    t.clock.quiet = true;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.quiet = false;
    t.clock.busy = true;
    expect(await t.waiting.tick()).toBe(false);
    t.clock.busy = false;
    expect(await t.relaunch().tick()).toBe(true);
    expect(t.shown[0]?.body).toBe("Pick up where you left off.");
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
