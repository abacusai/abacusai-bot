/**
 * Resolve the profile before stores capture its paths. Pending reset is finished
 * here, after the old process has exited and before Chromium opens its stores.
 */
import os from "node:os";
import path from "node:path";

import { app } from "electron";

import { initProfileHome, profileBaseDir } from "./profile-home";
import { finishPendingErase } from "./services/config/delete-all-data";

// A developer's isolated profile must never erase the real installation's
// legacy Chromium data. Only the normal installation owns that old directory.
const isolated = !app.isPackaged && process.env.ABACUSAI_BOT_USERDATA;
export const resetUserDataDirectories = isolated
  ? [isolated]
  : path.resolve(profileBaseDir()) === path.join(os.homedir(), ".abacusai-bot")
    ? [app.getPath("userData")]
    : [];
finishPendingErase(resetUserDataDirectories);
initProfileHome();
