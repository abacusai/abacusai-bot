/**
 * A table that failed to load is the sidebar's to show ("Couldn't load" +
 * Retry, spec 01 §7.3), not a route error: loaders preload, but a failed
 * preload lets the route render.
 */
export const ignoreLoadError = (): undefined => undefined;
