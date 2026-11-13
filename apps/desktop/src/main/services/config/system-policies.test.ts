import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createLoginItem,
  UnsupportedPlatformError,
  xdgAutostart,
} from "./login-item";
import { notificationSilent } from "./notification-policy";

describe("notificationSilent (spec 05 §31.5 d)", () => {
  it("keeps system notifications silent", () =>
    expect(notificationSilent()).toBe(true));
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

  it("on Linux, reads and writes the autostart entry instead of Electron", () => {
    const app = fakeApp();
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
    const item = createLoginItem(
      app,
      "linux",
      xdgAutostart({
        configHome,
        executable: "/opt/AbacusAI Bot/abacusai-bot",
        name: "AbacusAI Bot",
      })
    );
    const entry = path.join(configHome, "autostart", "abacusai-bot.desktop");
    expect(item.get()).toEqual({ openAtLogin: false });
    expect(item.set(true)).toEqual({ openAtLogin: true });
    expect(fs.readFileSync(entry, "utf8")).toContain(
      'Exec="/opt/AbacusAI Bot/abacusai-bot"'
    );
    fs.appendFileSync(entry, "Hidden=true\n");
    expect(item.get()).toEqual({ openAtLogin: false });
    expect(item.set(false)).toEqual({ openAtLogin: false });
    expect(fs.existsSync(entry)).toBe(false);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it("points an enabled entry at the current executable, and leaves a matching or turned-off one alone", () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
    const entry = path.join(configHome, "autostart", "abacusai-bot.desktop");
    const autostart = (executable: string) =>
      xdgAutostart({ configHome, executable, name: "AbacusAI Bot" });
    autostart("/apps/AbacusAI-Bot-1.0.0.AppImage").write(true);
    fs.appendFileSync(entry, "Comment=kept\n");

    autostart("/apps/AbacusAI-Bot-1.1.0.AppImage").refresh();
    const updated = fs.readFileSync(entry, "utf8");
    expect(updated).toContain('Exec="/apps/AbacusAI-Bot-1.1.0.AppImage"');
    expect(updated).not.toContain("1.0.0");
    expect(updated).toContain("Comment=kept");

    const write = vi.spyOn(fs, "writeFileSync");
    try {
      autostart("/apps/AbacusAI-Bot-1.1.0.AppImage").refresh();
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }

    fs.appendFileSync(entry, "Hidden=true\n");
    autostart("/apps/AbacusAI-Bot-1.2.0.AppImage").refresh();
    expect(fs.readFileSync(entry, "utf8")).not.toContain("1.2.0");

    fs.rmSync(entry);
    autostart("/apps/AbacusAI-Bot-1.2.0.AppImage").refresh();
    expect(fs.existsSync(entry)).toBe(false);
  });

  it("quotes an executable path with the desktop entry's special characters", () => {
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), "autostart-"));
    xdgAutostart({
      configHome,
      executable: '/home/a$b/"x"/100%/app',
      name: "AbacusAI Bot",
    }).write(true);
    expect(
      fs.readFileSync(
        path.join(configHome, "autostart", "abacusai-bot.desktop"),
        "utf8"
      )
    ).toContain('Exec="/home/a\\\\$b/\\\\"x\\\\"/100%%/app"');
  });
});
