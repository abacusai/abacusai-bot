import { describe, expect, it } from "vitest";

import {
  AVATAR_SHAPES,
  LIFECYCLE_MOODS,
  REACTION_MOODS,
} from "#renderer/lib/bots/avatar";

import {
  blinkAt,
  NAMED_EXPRESSIONS,
  namedExpression,
  blendExpressions,
  expressionFor,
  entryExpression,
  mouthPath,
  opticalSize,
  personalityFor,
  sampleExpression,
} from "./expression";
const moods = [...LIFECYCLE_MOODS, ...REACTION_MOODS];
describe("character expression", () => {
  it("uses hopeful approval, determined work and worried errors in product moods", () => {
    expect(expressionFor("waiting")).toEqual(expressionFor("idle", "hopeful"));
    expect(expressionFor("working")).toEqual(
      expressionFor("idle", "determined")
    );
    expect(expressionFor("error")).toEqual(expressionFor("idle", "worried"));
    expect(expressionFor("error").mouthOpen).toBeLessThan(1);
  });
  it("adds distinct asymmetric poses and bounded expression mixes", () => {
    const poses = NAMED_EXPRESSIONS.map(namedExpression);
    expect(new Set(poses.map((p) => JSON.stringify(p))).size).toBe(
      NAMED_EXPRESSIONS.length
    );
    expect(poses.every((p) => p.browAsymmetry !== 0)).toBe(true);
    expect(namedExpression("skeptical").rightEye).toBeGreaterThan(1);
    expect(namedExpression("shy").cheek).toBeGreaterThan(
      namedExpression("proud").cheek
    );
    const a = namedExpression("curious"),
      b = namedExpression("determined");
    expect(blendExpressions(a, b, -1)).toEqual(a);
    expect(blendExpressions(a, b, 2)).toEqual(b);
    expect(blendExpressions(a, b, 0.5).eyes).toBeCloseTo((a.eyes + b.eyes) / 2);
  });
  it("anticipates event hops, follows an arc, and settles without changing the face", () => {
    const base = expressionFor("done");
    const crouch = entryExpression(base, "done", "jelly", 0.05);
    const hop = entryExpression(base, "done", "jelly", 0.35);
    expect(crouch.stretch).toBeLessThan(1);
    expect(crouch.lift).toBeGreaterThan(base.lift);
    expect(hop.lift).toBeLessThan(base.lift);
    expect(hop.smile).toBe(base.smile);
    expect(entryExpression(base, "done", "jelly", 1)).toEqual(base);
    expect(base).toEqual(expressionFor("done"));
    expect(
      Math.abs(
        entryExpression(expressionFor("error"), "error", "pebble", 0.25).lean
      )
    ).toBeGreaterThan(0);
    for (const name of NAMED_EXPRESSIONS)
      for (const shape of AVATAR_SHAPES)
        expect(
          Object.values(sampleExpression("idle", shape, 3.7, 2, name)).every(
            Number.isFinite
          )
        ).toBe(true);
  });
  it("ties outline waves and body action to shape weight and mood", () => {
    const samples = (mood: "excited" | "idle", shape: "jelly" | "pebble") =>
      Array.from({ length: 80 }, (_, i) =>
        sampleExpression(mood, shape, i * 0.05, 0)
      );
    expect(
      Math.max(...samples("excited", "jelly").map((p) => -p.lift))
    ).toBeGreaterThan(5);
    expect(
      Math.max(...samples("idle", "jelly").map((p) => Math.abs(p.waveX)))
    ).toBeGreaterThan(
      Math.max(...samples("idle", "pebble").map((p) => Math.abs(p.waveX))) * 5
    );
  });
  it("coordinates pleasure, attention, sleep and concern", () => {
    for (const mood of ["happy", "done", "excited", "love"] as const) {
      const p = expressionFor(mood);
      expect(p.eyes).toBeLessThan(0.1);
      expect(p.lidCurve).toBeLessThan(0);
      expect(p.smile).toBeGreaterThan(5);
      expect(p.cheek).toBeGreaterThan(0.5);
    }
    for (const mood of ["sad", "blocked", "error"] as const) {
      const p = expressionFor(mood);
      expect(p.smile).toBeLessThan(0);
      expect(p.browTilt).toBeLessThan(0);
    }
    expect(expressionFor("listening").eyes).toBeGreaterThan(1);
    expect(expressionFor("listening").mouthWidth).toBeLessThan(10);
    expect(expressionFor("thinking").mouthX).toBeGreaterThan(0);
    expect(expressionFor("thinking").gazeY).toBeLessThan(0);
    expect(expressionFor("asleep").eyes).toBeLessThan(0.1);
  });
  it("returns independent poses and retains one mouth topology across every mood", () => {
    const p = expressionFor("idle");
    p.eyes = 0;
    expect(expressionFor("idle").eyes).toBe(1);
    const paths = moods.map((m) => mouthPath(expressionFor(m)));
    expect(new Set(paths.map((p) => p.replace(/[-\d.]+/g, "#"))).size).toBe(1);
    expect(
      new Set(moods.map((m) => JSON.stringify(expressionFor(m)))).size
    ).toBe(moods.length);
  });
  it("keeps motion finite and volume positive for every shape and mood", () => {
    for (const shape of AVATAR_SHAPES)
      for (const mood of moods)
        for (let t = 0; t < 20; t += 1.73) {
          const p = sampleExpression(mood, shape, t, 3.7);
          expect(Object.values(p).every(Number.isFinite)).toBe(true);
          expect(p.eyes).toBeGreaterThanOrEqual(0);
          expect(p.stretch).toBeGreaterThan(0.8);
          expect(p.stretch).toBeLessThan(1.2);
        }
  });
  it("varies speech width, aperture and pauses while the other features agree", () => {
    const samples = Array.from({ length: 100 }, (_, i) =>
      sampleExpression("talking", "mochi", i * 0.1, 2)
    );
    expect(Math.max(...samples.map((p) => p.mouthOpen))).toBeGreaterThan(6);
    expect(Math.min(...samples.map((p) => p.mouthOpen))).toBeLessThan(1);
    expect(
      new Set(samples.map((p) => p.mouthWidth.toFixed(1))).size
    ).toBeGreaterThan(15);
  });
  it("closes lids at irregular times, including double blinks", () => {
    let closures = 0;
    let wasClosed = false;
    const gaps: number[] = [];
    let last = 0;
    for (let t = 0; t < 100; t += 0.02) {
      const closed = blinkAt(t, 4) < 0.2;
      if (closed && !wasClosed) {
        closures++;
        gaps.push(t - last);
        last = t;
      }
      wasClosed = closed;
    }
    expect(closures).toBeGreaterThan(14);
    expect(gaps.some((g) => g < 0.5)).toBe(true);
    expect(new Set(gaps.map((g) => g.toFixed(1))).size).toBeGreaterThan(5);
  });
  it("gives heavy shapes slower periods and less rebound than soft or hopping shapes", () => {
    expect(personalityFor("pebble").weight).toBeGreaterThan(
      personalityFor("jelly").weight
    );
    expect(personalityFor("pebble").period).toBeGreaterThan(
      personalityFor("bunny").period
    );
    expect(personalityFor("bunny").bounce).toBeGreaterThan(
      personalityFor("cat").bounce
    );
  });
});
describe("optical sizing", () => {
  it("removes detail at 24px and enforces a one-pixel minimum line", () => {
    for (const size of [16, 24, 32, 44, 72, 160]) {
      const o = opticalSize(size);
      expect((o.line * size) / 100).toBeGreaterThanOrEqual(1);
      expect((o.eyeRadius * size) / 100).toBeGreaterThan(1);
      expect(o.cheeks).toBe(size > 24);
      expect(o.highlights).toBe(size >= 32);
      expect(o.particles).toBe(size >= 32);
    }
    expect(opticalSize(16).eyeRadius).toBeGreaterThan(
      opticalSize(160).eyeRadius
    );
  });
});
