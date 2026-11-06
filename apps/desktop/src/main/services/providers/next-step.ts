/**
 * Whether this install gets the next step (contract next-step.ts). The
 * hosted computer has no device to split by, so it stays as it is.
 * ABACUSAI_BOT_NEXT_STEP=on|off pins it for a test run.
 */
import { nextStepForDevice } from "@abacus-ai/contract/next-step";

import { deviceId } from "../debug-sync/device-id";

export const nextStepOn = (): boolean => {
  if (import.meta.env.ABACUS_WEB_HOST === true) return false;
  const pinned = process.env.ABACUSAI_BOT_NEXT_STEP;
  if (pinned === "on" || pinned === "off") return pinned === "on";
  return nextStepForDevice(deviceId());
};
