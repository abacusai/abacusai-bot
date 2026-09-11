/**
 * Notifications default ON, and the stored shape is what makes that true after
 * an upgrade: the file records what the user switched OFF, so a settings file
 * written before notifications had a switch still reads as "notify me".
 *
 * Storing `enabled` directly would have made every existing install silently
 * quiet, because an absent boolean is false.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

let home: string;

// The settings module resolves its path per call from ABACUSAI_BOT_HOME, so a
// plain import picks up whichever temp home the current case set.
const load = async (): Promise<typeof import("./settings")> =>
  import("./settings");

const writeSettingsFile = (contents: unknown): void => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(contents));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "notif-settings-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("notification settings", () => {
  it("is on, with sound, when nothing has ever been stored", async () => {
    const { readNotificationSettings } = await load();
    expect(readNotificationSettings()).toEqual({ enabled: true, sound: true });
  });

  it("stays on for a settings file written before the switch existed", async () => {
    // The upgrade case: real keys, no notification keys at all.
    writeSettingsFile({ sandbox: true, execBackend: "local" });
    const { readNotificationSettings } = await load();
    expect(readNotificationSettings()).toEqual({ enabled: true, sound: true });
  });

  it("records notifications being switched off, and back on", async () => {
    const { readNotificationSettings, setNotificationSettings } = await load();
    expect(setNotificationSettings({ enabled: false, sound: true })).toEqual({
      enabled: false,
      sound: true,
    });
    expect(readNotificationSettings().enabled).toBe(false);
    expect(
      setNotificationSettings({ enabled: true, sound: true }).enabled
    ).toBe(true);
  });

  it("keeps notifications on when only the sound is switched off", async () => {
    const { setNotificationSettings } = await load();
    expect(setNotificationSettings({ enabled: true, sound: false })).toEqual({
      enabled: true,
      sound: false,
    });
  });

  it("leaves unrelated settings alone", async () => {
    writeSettingsFile({ sandbox: true, execDockerImage: "debian:bookworm" });
    const { setNotificationSettings } = await load();
    setNotificationSettings({ enabled: false, sound: false });
    const stored = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(stored.sandbox).toBe(true);
    expect(stored.execDockerImage).toBe("debian:bookworm");
  });

  it("writes the inverted flags, so absence keeps meaning on", async () => {
    const { setNotificationSettings } = await load();
    setNotificationSettings({ enabled: true, sound: true });
    const stored = JSON.parse(
      fs.readFileSync(path.join(home, "config.json"), "utf-8")
    ) as Record<string, unknown>;
    expect(stored.notificationsDisabled).toBe(false);
    expect(stored.notificationSoundDisabled).toBe(false);
  });
});
