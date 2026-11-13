/**
 * The app opens at login, from the first sign-in on. Registered once per
 * install: the OS tells the user it happened, and a user who then turns it
 * off in the system settings is not signed up again. On Linux it is an XDG
 * autostart entry.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { app } from "electron";

import { profileBaseDir } from "./profile-home";
import {
  type LinuxAutostart,
  xdgAutostart,
} from "./services/config/login-item";

const MARKER = "login-item";

/** A packaged Linux app's autostart entry; null elsewhere, and in a dev build (it would start the bare Electron binary). */
export const appLinuxAutostart = (): LinuxAutostart | null =>
  process.platform === "linux" && app.isPackaged
    ? xdgAutostart({
        configHome:
          process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
        executable: process.env.APPIMAGE || process.execPath,
        name: "AbacusAI Bot",
      })
    : null;

export const registerLoginItem = (): void => {
  // A dev build would register the bare Electron binary.
  if (!app.isPackaged) return;
  const linux = appLinuxAutostart();
  if (process.platform !== "darwin" && process.platform !== "win32" && !linux)
    return;
  const marker = path.join(profileBaseDir(), MARKER);
  if (fs.existsSync(marker)) return;
  try {
    if (linux != null) linux.write(true);
    else app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (error) {
    console.warn(
      `[login-item] not registered: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/**
 * On each launch: an AppImage update moves the app to a new versioned file
 * and deletes the old one, so an enabled autostart entry follows it.
 */
export const refreshLinuxAutostart = (): void => {
  try {
    appLinuxAutostart()?.refresh();
  } catch (error) {
    console.warn(
      `[login-item] autostart not refreshed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/** A start this soon after the computer booted, with the login item on, is the login item's. */
const LOGIN_START_WITHIN_S = 180;

/** Whether the OS started this launch at login, rather than the user. */
export const openedAtLogin = (): boolean => {
  if (!app.isPackaged) return false;
  if (process.platform !== "darwin" && process.platform !== "win32")
    return false;
  try {
    const settings = app.getLoginItemSettings();
    if (!settings.openAtLogin) return false;
    return (
      settings.wasOpenedAtLogin === true || os.uptime() < LOGIN_START_WITHIN_S
    );
  } catch {
    return false;
  }
};
