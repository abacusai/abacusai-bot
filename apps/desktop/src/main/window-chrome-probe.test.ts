import { afterEach, expect, it, vi } from "vitest";

import { hasOverlayGeometry, probeWindowChrome } from "./window-chrome-probe";

const geometry = {
  visible: true,
  x: 0,
  width: 900,
  height: 40,
  windowWidth: 1000,
};
afterEach(() => vi.useRealTimers());

it("accepts geometry that reserves native controls on either side", async () => {
  expect(await probeWindowChrome(async () => geometry)).toBe(true);
  expect(hasOverlayGeometry({ ...geometry, x: 100 })).toBe(true);
});

it.each([
  null,
  { ...geometry, visible: false },
  { ...geometry, width: 0 },
  { ...geometry, height: 0 },
  { ...geometry, width: 1000 },
  { ...geometry, x: 500 },
])("rejects unavailable geometry %j", async (value) => {
  expect(await probeWindowChrome(async () => value)).toBe(false);
});

it("bounds a hung renderer probe to 1.5 seconds", async () => {
  vi.useFakeTimers();
  const result = probeWindowChrome(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toBe(false);
});

it("treats a rejected probe as unavailable", async () => {
  expect(
    await probeWindowChrome(async () => {
      throw new Error("view disposed");
    })
  ).toBe(false);
});
