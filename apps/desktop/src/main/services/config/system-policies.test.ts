import { describe, expect, it, vi } from "vitest";

import { createLoginItem, UnsupportedPlatformError } from "./login-item";
import { notificationSilent } from "./notification-policy";

describe("notificationSilent (spec 05 §31.5 d)", () => {
  it("is always silent in the wco generation", () => {
    expect(notificationSilent("wco", true)).toBe(true);
    expect(notificationSilent("wco", false)).toBe(true);
  });

  it("keeps the legacy generation's sound setting", () => {
    expect(notificationSilent("legacy", true)).toBe(false);
    expect(notificationSilent("legacy", false)).toBe(true);
  });
});

describe("createLoginItem (spec 05 §31.5 c)", () => {
  const fakeApp = () => {
    let openAtLogin = false;
    return {
      getLoginItemSettings: vi.fn(() => ({ openAtLogin })),
      setLoginItemSettings: vi.fn((settings: { openAtLogin: boolean }) => {
        openAtLogin = settings.openAtLogin;
      }),
    };
  };

  it.each(["darwin", "win32"])("reads and writes on %s", (platform) => {
    const app = fakeApp();
    const item = createLoginItem(app, platform);
    expect(item.get()).toEqual({ openAtLogin: false });
    expect(item.set(true)).toEqual({ openAtLogin: true });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
  });

  it("refuses on Linux without touching Electron", () => {
    const app = fakeApp();
    const item = createLoginItem(app, "linux");
    expect(() => item.get()).toThrow(UnsupportedPlatformError);
    expect(() => item.set(true)).toThrow(UnsupportedPlatformError);
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
