import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CHECK_IN_PROMPT,
  NAME_ONLY_MISSION,
  describeCheckIn,
  type CheckInPreset,
} from "./check-in";
import type { Weekday } from "./schedule";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./__fixtures__/legacy-model-strings/${name}`, import.meta.url),
    "utf8"
  );

describe("R3-T9 shared migration immutable oracle", () => {
  it("preserves the pre-migration model-facing bytes", () => {
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
  it("the legacy dialog exports the shared bytes and calls the shared description helper", () => {
    const source = readFileSync(
      new URL(
        "../../renderer/components/bots/new-bot-dialog.tsx",
        import.meta.url
      ),
      "utf8"
    );
    expect(source).toContain(
      'export { NAME_ONLY_MISSION, CHECK_IN_PROMPT } from "#shared/bots/check-in";'
    );
    expect(source).toMatch(
      /import\s*\{\s*NAME_ONLY_MISSION,\s*CHECK_IN_PROMPT,\s*describeCheckIn,?\s*\} from "#shared\/bots\/check-in";/
    );
    expect(source).not.toContain("function describeCheckIn");
  });
});
