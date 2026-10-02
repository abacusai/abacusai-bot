import type { AppQueryUtils } from "#next/data/transport";

/**
 * The native chrome's state (spec 00-window-chrome §6): capability mode,
 * full screen, density and toolbar height. Kept current by `window.events`
 * `chrome` notices through the invalidation table.
 */
export const windowChromeQuery = (orpc: AppQueryUtils) =>
  orpc.window.chrome.queryOptions({ input: {} });
