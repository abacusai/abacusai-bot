/**
 * A table that failed to load is the sidebar's to show ("Couldn't load" +
 * Retry, spec 01 §7.3), not a route error: loaders preload, but a failed
 * preload lets the route render.
 */
export const ignoreLoadError = (): undefined => undefined;

/**
 * The row is known not to exist: its table loaded and does not have it. A
 * table still loading or in error says nothing (Claude impl r1 #20).
 */
export const isMissing = (
  collection: { readonly status: string; has(key: string): boolean },
  key: string
): boolean => collection.status === "ready" && !collection.has(key);
