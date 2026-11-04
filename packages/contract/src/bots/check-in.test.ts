import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHECK_IN_PROMPT,
  GOAL_MISSION,
  NAME_ONLY_MISSION,
  describeCheckIn,
  goalOfMission,
  missionForCheckIn,
  type CheckInPreset,
} from "./check-in";
import type { Weekday } from "./schedule";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/legacy-model-strings/${name}`, import.meta.url),
    "utf8"
  );

describe("R3-T9 shared migration immutable oracle", () => {
  it("preserves main's model-facing bytes after the shared migration", () => {
    expect(CHECK_IN_PROMPT).toBe(fixture("check-in-prompt.txt"));
    expect(NAME_ONLY_MISSION).toBe(fixture("name-only-mission.txt"));
    for (const { input, output } of JSON.parse(
      fixture("describe-check-in.json")
    ) as {
      input: { preset: CheckInPreset; time: string; weekday: Weekday };
      output: string;
    }[]) {
      expect(describeCheckIn(input)).toBe(output);
      expect(describeCheckIn(input.preset, input.time, input.weekday)).toBe(
        output
      );
    }
  });
});

describe("a mission in the user's own words", () => {
  it("quotes them, takes a first step, asks at most once and connects only what the step needs", () => {
    expect(GOAL_MISSION("  progamador de sites ")).toBe(
      'The user created you for this, in their own words: "progamador de sites". ' +
        "That is your whole mission; nothing else is implied. On your first turn, " +
        "take the first useful step toward it right away with the tools you have " +
        "(a plan, a draft, a first file, a first search). Ask at most one question, " +
        "and only if you cannot take any step without the answer. Do not create " +
        "routines unless the user's words name a time or rhythm. Ask for a " +
        "connector only when the step you are taking needs it, never for apps the " +
        "goal does not use."
    );
  });

  it("gives the words back, and nothing for any other mission", () => {
    expect(goalOfMission(GOAL_MISSION('send "job" application emails'))).toBe(
      'send "job" application emails'
    );
    expect(goalOfMission(NAME_ONLY_MISSION)).toBeNull();
    expect(goalOfMission("Watch the news.")).toBeNull();
  });
});

describe("missionForCheckIn", () => {
  it("is the mission a run works from: the user's own words, or nothing yet", () => {
    expect(missionForCheckIn("Watch the shop.")).toBe("Watch the shop.");
    expect(missionForCheckIn(GOAL_MISSION("Watch the shop"))).toBe(
      "Watch the shop"
    );
    expect(missionForCheckIn(NAME_ONLY_MISSION)).toBeNull();
    expect(missionForCheckIn("  ")).toBeNull();
  });
});
