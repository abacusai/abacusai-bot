import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
vi.mock("electron-store", () => ({
  default: class {
    get(key: string) {
      return state.get(key);
    }
    set(key: string, value: unknown) {
      state.set(key, value);
    }
  },
}));

import {
  getTitlebarDensity,
  persistLinuxNativeFrame,
  setTitlebarDensity,
  useLinuxNativeFrame,
} from "./window-chrome-settings";

beforeEach(() => state.clear());
it("defaults to comfortable and persists compact", () => {
  expect(getTitlebarDensity()).toBe("comfortable");
  expect(setTitlebarDensity("compact")).toBe("compact");
  expect(state.get("titlebarDensity")).toBe("compact");
  expect(getTitlebarDensity()).toBe("compact");
  setTitlebarDensity("comfortable");
  expect(getTitlebarDensity()).toBe("comfortable");
});
it("rejects invalid writes and tolerates invalid stored density", () => {
  expect(() => setTitlebarDensity("invalid")).toThrow(
    "Invalid titlebar density"
  );
  expect(state.has("titlebarDensity")).toBe(false);
  state.set("titlebarDensity", "invalid");
  expect(getTitlebarDensity()).toBe("comfortable");
});
it("persists Linux probe failure so subsequent windows use a native frame", () => {
  expect(useLinuxNativeFrame()).toBe(false);
  persistLinuxNativeFrame();
  expect(state.get("linuxChromeMode")).toBe("native-frame");
  expect(useLinuxNativeFrame()).toBe(true);
});
