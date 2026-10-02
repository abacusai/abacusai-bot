import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => new Map<string, unknown>());
const constructed = vi.hoisted(() => vi.fn());
vi.mock("electron-store", () => ({
  default: class {
    constructor(options: unknown) {
      constructed(options);
    }
    get(key: string) {
      return state.get(key);
    }
    set(key: string, value: unknown) {
      state.set(key, value);
    }
  },
}));

import { abacusBotHome } from "./paths";
import {
  getTitlebarDensity,
  linuxNativeFrameKey,
  persistLinuxNativeFrame,
  setTitlebarDensity,
  useLinuxNativeFrame,
} from "./window-chrome-settings";

beforeEach(() => state.clear());
it("creates the settings store lazily in abacusBotHome", () => {
  expect(constructed).not.toHaveBeenCalled();
  getTitlebarDensity();
  expect(constructed).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: abacusBotHome(), name: "settings" })
  );
});
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
  expect(state.get("linuxNativeFrameKey")).toBe(linuxNativeFrameKey());
  expect(useLinuxNativeFrame()).toBe(true);
});

it("reprobes when the Electron version or desktop changes", () => {
  const key = linuxNativeFrameKey("44.4.1", "GNOME");
  persistLinuxNativeFrame(key);
  expect(useLinuxNativeFrame(linuxNativeFrameKey("44.4.1", "gnome"))).toBe(
    true
  );
  expect(useLinuxNativeFrame(linuxNativeFrameKey("44.4.2", "GNOME"))).toBe(
    false
  );
  expect(useLinuxNativeFrame(linuxNativeFrameKey("44.4.1", "KDE"))).toBe(false);
});
