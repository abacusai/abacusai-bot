import { describe, expect, it } from "vitest";

import hardware from "./fixtures/notched-mac.json";
import {
  devMetrics,
  matchScreens,
  metricsFromProbe,
  parseProbe,
} from "./metrics";
const screen = {
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  top: 32,
  left: 656,
  right: 656,
};
describe("R6-T24 parser contract, synthetic and recorded AppKit inputs", () => {
  it("uses measured AppKit areas only", () => {
    expect(parseProbe(JSON.stringify({ ok: true, screens: [screen] }))).toEqual(
      { kind: "ok", screens: [screen] }
    );
    expect(metricsFromProbe(screen)).toEqual({
      x: 656,
      width: 200,
      height: 32,
    });
    expect(
      metricsFromProbe({ ...screen, top: 0, left: 0, right: 0 })
    ).toBeNull();
    expect(parseProbe('{"ok":false,"reason":"selectors-unavailable"}')).toEqual(
      { kind: "unavailable", reason: "selectors-unavailable" }
    );
  });
  it.each(["garbage", "null", '{"ok":true,"screens":[{}]}'])(
    "fails closed on %s",
    (raw) =>
      expect(parseProbe(raw)).toEqual({ kind: "unavailable", reason: "parse" })
  );
  it("matches a display above and left of the primary using points", () => {
    const second = {
      ...screen,
      frame: { x: -1512, y: 982, width: 1512, height: 982 },
    };
    const bounds = { x: -1512, y: -982, width: 1512, height: 982 };
    expect(
      matchScreens([second], [{ id: 9, bounds, workArea: bounds }], 982).get(9)
    ).toEqual({ x: 656, width: 200, height: 32 });
  });
  it("ignores a packaged override", () => {
    expect(devMetrics("200x32", true)).toBeNull();
    expect(devMetrics("200x32", false)).toEqual({ width: 200, height: 32 });
  });
});

it("R6-T24 parses the physical MacBook probe captured for this implementation", () => {
  const result = parseProbe(JSON.stringify(hardware.probe));
  expect(result.kind).toBe("ok");
  if (result.kind === "ok")
    expect(metricsFromProbe(result.screens[0]!)).toEqual({
      x: 763,
      width: 185,
      height: 33,
    });
});

it("preserves asymmetric auxiliary origins on an offset display", () => {
  const s = {
    ...screen,
    frame: { ...screen.frame, x: -1512 },
    leftArea: { x: -1512, y: 950, width: 600, height: 32 },
    rightArea: { x: -700, y: 950, width: 700, height: 32 },
  };
  expect(metricsFromProbe(s)).toEqual({ x: 600, width: 212, height: 32 });
});
it("rejects malformed auxiliary geometry", () => {
  expect(
    parseProbe(
      JSON.stringify({
        ok: true,
        screens: [
          { ...screen, leftArea: { x: 0, y: 0, width: -1, height: 32 } },
        ],
      })
    )
  ).toEqual({ kind: "unavailable", reason: "parse" });
});
