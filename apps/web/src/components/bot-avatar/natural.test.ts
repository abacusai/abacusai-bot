import { describe, expect, it } from "vitest";

import { LIFECYCLE_MOODS, REACTION_MOODS } from "#renderer/lib/bots/avatar";

import {
  individualExpression,
  expressionFor,
  NAMED_EXPRESSIONS,
} from "./expression";
import { blinkSchedule, gazeSchedule, speechSchedule } from "./natural";
import { personalityFromIdentity } from "./personality";

const p = personalityFromIdentity("bot-17");
describe("natural motion schedules", () => {
  it("holds between blinks, jitters gaps and closes faster than it reopens", () => {
    const frames = blinkSchedule("bot-17", p);
    const closures = frames.filter((f) => f.transform === "scaleY(.025)");
    const intervals = closures
      .slice(1)
      .map((f, i) => f.offset - closures[i]!.offset);
    expect(new Set(intervals.map((t) => t.toFixed(4))).size).toBeGreaterThan(8);
    expect(frames).toEqual(blinkSchedule("bot-17", p));
    expect(closures.length).toBeGreaterThan(10);
    const i = frames.indexOf(closures[0]!);
    expect(frames[i]!.offset - frames[i - 1]!.offset).toBeLessThan(
      frames[i + 1]!.offset - frames[i]!.offset
    );
  });
  it("keeps gaze timelines closed without turning or flattening the body", () => {
    const { gaze } = gazeSchedule("bot-17", p);
    expect(gaze.every((f) => !String(f.transform).match(/rotate|scaleX/))).toBe(
      true
    );
    for (const frames of [
      blinkSchedule("bot-17", p),
      gaze,
      speechSchedule("bot-17", p),
    ]) {
      expect(frames[0]!.offset).toBe(0);
      expect(frames.at(-1)!.offset).toBe(1);
      expect(frames.at(-1)!.transform).toBe(frames[0]!.transform);
      for (let i = 1; i < frames.length; i++)
        expect(frames[i]!.offset).toBeGreaterThan(frames[i - 1]!.offset!);
    }
  });
  it("preserves every emotional and named expression with finite identity coupling", () => {
    for (let i = 0; i < 200; i++) {
      const person = personalityFromIdentity(`bot-${i}`);
      for (const mood of [...LIFECYCLE_MOODS, ...REACTION_MOODS]) {
        const pose = individualExpression(expressionFor(mood), person);
        expect(Object.values(pose).every(Number.isFinite)).toBe(true);
        expect(pose.eyes).toBeGreaterThanOrEqual(0);
        if (["happy", "asleep", "love", "done"].includes(mood))
          expect(pose.eyes).toBeLessThan(0.1);
      }
      for (const name of NAMED_EXPRESSIONS)
        expect(
          Object.values(
            individualExpression(expressionFor("idle", name), person)
          ).every(Number.isFinite)
        ).toBe(true);
    }
  });
});
