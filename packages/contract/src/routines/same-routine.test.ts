import { describe, expect, it } from "vitest";

import { CHECK_IN_PROMPT } from "../bots/check-in";
import {
  duplicateRoutines,
  routineMatch,
  type RoutineFacts,
  type RoutineMatch,
} from "./same-routine";

const routine = (over: Partial<RoutineFacts> = {}): RoutineFacts => ({
  name: "Morning brief",
  prompt: "Summarize my inbox and my calendar for today.",
  schedule: "0 8 * * *",
  runAt: null,
  botId: "bot-1",
  webhook: false,
  timezone: null,
  watchUrl: null,
  ...over,
});

const CHECK_IN = routine({
  name: "Scout check-in",
  prompt: CHECK_IN_PROMPT,
  schedule: "0 * * * *",
});

const cases: Array<
  [string, RoutineFacts, RoutineFacts, RoutineMatch | null, boolean?]
> = [
  ["word for word", routine(), routine(), "same"],
  [
    "case, spacing, accents",
    routine({ prompt: "SUMMARIZE  my inbox, and my cálendar for today" }),
    routine(),
    "same",
  ],
  [
    "one cron spelled two ways",
    routine({ schedule: "0,30 6-22 * * *" }),
    routine({ schedule: "*/30 6-22 * * *" }),
    "same",
  ],
  [
    "Sunday as 0 and as 7",
    routine({ schedule: "0 8 * * 0" }),
    routine({ schedule: "0 8 * * 7" }),
    "same",
  ],
  [
    "near-same wording",
    routine({ prompt: "Summarize my inbox and my calendar for tomorrow." }),
    routine(),
    "alike",
  ],
  [
    "other words, same name",
    routine({ prompt: "Whatever is new." }),
    routine(),
    "alike",
  ],
  [
    "other words, same channel",
    routine({ name: "A", prompt: "Answer tasks in #team-updates." }),
    routine({
      name: "B",
      prompt: "Reply in threads on #Team-Updates when named.",
    }),
    "alike",
  ],
  [
    "a retried one-time moment",
    routine({ schedule: null, runAt: 60_000 }),
    routine({ schedule: null, runAt: 120_000 }),
    "same",
  ],
  [
    "webhook-only, word for word",
    routine({ schedule: null }),
    routine({ schedule: null }),
    "same",
  ],
  ["another owner", routine({ botId: "bot-2" }), routine(), null],
  ["the user's and a bot's", routine({ botId: null }), routine(), null],
  ["another time", routine({ schedule: "0 9 * * *" }), routine(), null],
  [
    "a rarer schedule inside a frequent one",
    routine({ schedule: "0 9 * * *" }),
    routine({ schedule: "*/5 * * * *" }),
    null,
  ],
  [
    "another zone",
    routine({ timezone: "UTC" }),
    routine({ timezone: "Asia/Kolkata" }),
    null,
  ],
  [
    "another job at that time",
    routine({
      name: "Backup",
      prompt: "Copy the project folder to the drive.",
    }),
    routine(),
    null,
  ],
  [
    "one word apart, short",
    routine({ name: "B", prompt: "Check BTC price" }),
    routine({ name: "E", prompt: "Check ETH price" }),
    null,
  ],
  [
    "two one-time moments",
    routine({ schedule: null, runAt: 0 }),
    routine({ schedule: null, runAt: 600_000 }),
    null,
  ],
  [
    "webhook-only, other words",
    routine({ schedule: null, prompt: "One" }),
    routine({ schedule: null, prompt: "Two" }),
    null,
  ],
  ["wants a webhook it lacks", routine({ webhook: true }), routine(), null],
  [
    "watches another page",
    routine({ watchUrl: "https://a.example/" }),
    routine({ watchUrl: "https://b.example/" }),
    null,
  ],
  [
    "a colour is no channel",
    routine({ name: "A", prompt: "Paint it #fff000 today" }),
    routine({ name: "B", prompt: "Print #fff000 labels" }),
    null,
  ],
  [
    "calls itself a check-in",
    routine({
      name: "Hourly check-in",
      schedule: "5 * * * *",
      prompt: "Look around.",
    }),
    CHECK_IN,
    "alike",
  ],
  [
    "hourly work beside a check-in",
    routine({
      name: "Prices",
      schedule: "0 * * * *",
      prompt: "Read the prices.",
    }),
    CHECK_IN,
    null,
  ],
  [
    "any routine on the check-in's rhythm, after an edit",
    routine({
      name: "Sweep",
      schedule: "0 * * * *",
      prompt: "Read the prices.",
    }),
    CHECK_IN,
    "alike",
    true,
  ],
  [
    "another rhythm, after an edit",
    routine({
      name: "Sweep",
      schedule: "0 9 * * *",
      prompt: "Read the prices.",
    }),
    CHECK_IN,
    null,
    true,
  ],
  [
    "its old job at a new time, after an edit",
    routine({ schedule: "0 9 * * *" }),
    routine(),
    "alike",
    true,
  ],
  [
    "its old job at a new time, otherwise",
    routine({ schedule: "0 9 * * *" }),
    routine(),
    null,
  ],
];

describe("routineMatch", () => {
  it.each(cases)("%s", (_label, made, existing, expected, missionEdited) => {
    expect(routineMatch(made, existing, { missionEdited })).toBe(expected);
  });
});

describe("duplicateRoutines", () => {
  const row = (
    id: string,
    enabled: boolean,
    over: Partial<RoutineFacts> = {}
  ) => ({
    ...routine(over),
    id,
    enabled,
  });

  it("pairs routines that both run, whichever way round", () => {
    const found = duplicateRoutines([
      row("a", true),
      row("b", true),
      row("c", true, { schedule: "0 9 * * *" }),
    ]);
    expect([...found.keys()]).toEqual(["a", "b"]);
    expect(found.get("a")?.map((twin) => twin.id)).toEqual(["b"]);
  });

  it("leaves a pair alone once one of them is paused", () => {
    expect(duplicateRoutines([row("a", true), row("b", false)]).size).toBe(0);
  });

  it("flags a routine that repeats its bot's check-in", () => {
    const found = duplicateRoutines([
      { ...CHECK_IN, id: "a", enabled: true },
      row("b", true, {
        name: "Hourly check-in",
        schedule: "0 * * * *",
        prompt: "Look at the inbox.",
      }),
    ]);
    expect(found.size).toBe(2);
  });
});
