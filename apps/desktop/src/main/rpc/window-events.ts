/**
 * `window.events` fan-out. Window facts (full screen, maximize, focus,
 * chrome) belong to the window, not to one renderer in it: every view the
 * transport trusts in that window gets them, so a swap candidate that
 * subscribed before the flip does not become visible with stale state.
 */
import type { WindowEvent } from "#shared/contract";

import type { BusChannels } from "./event-bus";

export type PublishWindowEvent = (
  channel: "window",
  payload: BusChannels["window"]
) => void;

/**
 * Publishes `event` to each of `views` (webContents ids), plus `live` when
 * the transport has not registered it (a legacy renderer that never
 * connected still has nothing listening; publishing is harmless).
 */
export const publishToWindowViews = (
  publish: PublishWindowEvent,
  views: Iterable<number>,
  live: number | null,
  event: WindowEvent
): void => {
  const ids = new Set(views);
  if (live != null) ids.add(live);
  for (const webContentsId of ids) publish("window", { webContentsId, event });
};
