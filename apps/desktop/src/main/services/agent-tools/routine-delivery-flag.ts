/**
 * Flag `routine-delivery`: the app delivers each local routine run's report
 * to the chat it belongs to and the user's own chat app, and the user answers
 * a run there (routine-report-delivery.ts). On in development and test builds,
 * off in a release until its flip. ABACUSAI_BOT_ROUTINE_DELIVERY=on|off pins
 * it. The hosted computer's routines are the server's to deliver.
 */
import { app } from "electron";

import { isTestBuild } from "../providers/abacus-host";

export const routineDeliveryOn = (): boolean => {
  if (import.meta.env.ABACUS_WEB_HOST === true) return false;
  const pinned = process.env.ABACUSAI_BOT_ROUTINE_DELIVERY;
  if (pinned === "on" || pinned === "off") return pinned === "on";
  return !app.isPackaged || isTestBuild();
};
