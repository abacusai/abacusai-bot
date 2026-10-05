import type { LookStore } from "#renderer/lib/theme";

/** Electron's host is always connected: nothing provisional to remember. */
export const readLastKnown = <T>(
  _kind: "gate" | "system" | "destination" | "look"
): T | null => null;
export const writeLastKnown = (
  _kind: "gate" | "system" | "destination" | "look",
  _value: unknown
) => {};
/** The desktop app keeps its boot look itself (lib/theme.ts localLookStore). */
export const lookStore: LookStore = { read: () => null, write: () => {} };
