import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  isPackaged: true,
  setLoginItemSettings: vi.fn(),
}));
vi.mock("electron", () => ({ app: electron }));

let base = "";
vi.mock("./profile-home", () => ({ profileBaseDir: () => base }));

const { refreshLinuxAutostart, registerLoginItem } =
  await import("./login-item");

describe("the login item", () => {
  const platform = process.platform;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "login-item-"));
    electron.isPackaged = true;
    electron.setLoginItemSettings.mockReset();
    Object.defineProperty(process, "platform", { value: "darwin" });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("is registered once per install", () => {
    registerLoginItem();
    registerLoginItem();

    expect(electron.setLoginItemSettings).toHaveBeenCalledTimes(1);
    expect(electron.setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
    expect(fs.existsSync(path.join(base, "login-item"))).toBe(true);
  });

  it("leaves a dev build alone", () => {
    electron.isPackaged = false;
    registerLoginItem();
    Object.defineProperty(process, "platform", { value: "linux" });
    registerLoginItem();

    expect(electron.setLoginItemSettings).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(base, "login-item"))).toBe(false);
  });

  it("on Linux, writes the autostart entry once, and not again after the user removes it", () => {
    const configHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(base, "config");
    const entry = path.join(
      base,
      "config",
      "autostart",
      "abacusai-bot.desktop"
    );
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      registerLoginItem();
      expect(fs.readFileSync(entry, "utf8")).toContain("Exec=");
      fs.rmSync(entry);
      registerLoginItem();

      expect(fs.existsSync(entry)).toBe(false);
      expect(electron.setLoginItemSettings).not.toHaveBeenCalled();
    } finally {
      if (configHome == null) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = configHome;
    }
  });

  it("on Linux, a launch after an AppImage update points the entry at the new file", () => {
    const configHome = process.env.XDG_CONFIG_HOME;
    const appImage = process.env.APPIMAGE;
    process.env.XDG_CONFIG_HOME = path.join(base, "config");
    const entry = path.join(
      base,
      "config",
      "autostart",
      "abacusai-bot.desktop"
    );
    try {
      Object.defineProperty(process, "platform", { value: "linux" });
      process.env.APPIMAGE = "/apps/AbacusAI-Bot-1.0.0.AppImage";
      registerLoginItem();
      process.env.APPIMAGE = "/apps/AbacusAI-Bot-1.1.0.AppImage";
      registerLoginItem();
      refreshLinuxAutostart();

      expect(fs.readFileSync(entry, "utf8")).toContain(
        'Exec="/apps/AbacusAI-Bot-1.1.0.AppImage"'
      );
    } finally {
      if (configHome == null) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = configHome;
      if (appImage == null) delete process.env.APPIMAGE;
      else process.env.APPIMAGE = appImage;
    }
  });
});
