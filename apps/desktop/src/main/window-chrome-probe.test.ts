import { afterEach, expect, it, vi } from "vitest";

import {
  hasOverlayGeometry,
  probeWindowChrome,
  waitForChromeProbeWindow,
} from "./window-chrome-probe";

const geometry = {
  visible: true,
  x: 0,
  width: 900,
  height: 40,
  windowWidth: 1000,
};
afterEach(() => vi.useRealTimers());

it("accepts geometry that reserves native controls on either side", async () => {
  expect(await probeWindowChrome(async () => geometry)).toBe("available");
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
  vi.useFakeTimers();
  const result = probeWindowChrome(async () => value);
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toBe("unavailable");
});

it("bounds a hung renderer probe to 1.5 seconds", async () => {
  vi.useFakeTimers();
  const result = probeWindowChrome(() => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(1500);
  expect(await result).toBe("retry-later");
});

it("retries later when a swapped renderer rejects the probe", async () => {
  expect(
    await probeWindowChrome(async () => {
      throw new Error("view disposed");
    })
  ).toBe("retry-later");
});

it("polls the current host view after a swap using timers", async () => {
  vi.useFakeTimers();
  const old = { executeJavaScript: vi.fn(async () => null) };
  const current = { executeJavaScript: vi.fn(async () => geometry) };
  const host = { webContents: old as typeof old | typeof current };
  const result = probeWindowChrome(() => host.webContents.executeJavaScript());
  await vi.advanceTimersByTimeAsync(25);
  host.webContents = current;
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe("available");
  expect(old.executeJavaScript).toHaveBeenCalledOnce();
  expect(current.executeJavaScript).toHaveBeenCalledOnce();
});

it("does not read a minimized window or disable its overlay", async () => {
  const read = vi.fn();
  expect(await probeWindowChrome(read, () => true)).toBe("retry-later");
  expect(read).not.toHaveBeenCalled();
});

it("retries later if minimized while polling", async () => {
  vi.useFakeTimers();
  let minimized = false;
  const result = probeWindowChrome(
    async () => null,
    () => minimized
  );
  await vi.advanceTimersByTimeAsync(25);
  minimized = true;
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toBe("retry-later");
});

it("R7-T28: hidden and minimized probes wait for one native event without timers", () => {
  vi.useFakeTimers();
  let listener: (() => void) | undefined;
  const once = vi.fn((_event: string, fn: () => void) => {
    listener = fn;
  });
  const probe = vi.fn();
  const window = {
    isVisible: () => false,
    isMinimized: () => false,
    isFullScreen: () => false,
    once,
  };
  expect(waitForChromeProbeWindow(window, probe)).toBe(true);
  expect(once).toHaveBeenCalledWith("show", probe);
  expect(vi.getTimerCount()).toBe(0);
  listener?.();
  expect(probe).toHaveBeenCalledOnce();
  expect(
    waitForChromeProbeWindow({ ...window, isMinimized: () => true }, probe)
  ).toBe(true);
  expect(once).toHaveBeenLastCalledWith("restore", probe);
  expect(
    waitForChromeProbeWindow({ ...window, isVisible: () => true }, probe)
  ).toBe(false);
});
