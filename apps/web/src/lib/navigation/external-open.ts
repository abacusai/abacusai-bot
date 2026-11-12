/**
 * The last time something outside the page asked to open a place (an
 * `abacusaibot://` link, a notification click), so the app's own landing on
 * return never overrides it.
 */
let externalOpenAt = 0;

export const markExternalOpen = (now = Date.now()): void => {
  externalOpenAt = now;
};

/** Whether an outside open came at or after `since`. */
export const externalOpenSince = (since: number): boolean =>
  externalOpenAt >= since;
