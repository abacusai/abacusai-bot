/**
 * Side-effect module: selects the active profile's home directory. Must be
 * imported first in index.ts, before any module captures abacusBotHome().
 */
import { app } from "electron";

import { initProfileHome } from "./profile-home";
import { finishPendingErase } from "./services/config/delete-all-data";

// Finish an erase the last run could not (Windows keeps open files locked).
finishPendingErase(
  !app.isPackaged && process.env.ABACUSAI_BOT_USERDATA
    ? []
    : [app.getPath("userData")]
);

initProfileHome();
