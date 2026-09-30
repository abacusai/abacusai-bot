/**
 * The app opens at login, from the first sign-in on. Registered once per
 * install: the OS tells the user it happened, and a user who then turns it
 * off in the system settings is not signed up again.
 */
import fs from "fs";
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
