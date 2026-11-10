/**
 * The app opens at login, from the first sign-in on. Registered once per
 * install: the OS tells the user it happened, and a user who then turns it
 * off in the system settings is not signed up again.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { app } from "electron";

import { profileBaseDir } from "./profile-home";

const MARKER = "login-item";

export const registerLoginItem = (): void => {
  // A dev build would register the bare Electron binary.
  if (!app.isPackaged) return;
  if (process.platform !== "darwin" && process.platform !== "win32") return;
  const marker = path.join(profileBaseDir(), MARKER);
  if (fs.existsSync(marker)) return;
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (error) {
    console.warn(
      `[login-item] not registered: ${error instanceof Error ? error.message : String(error)}`
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
