/** Electron's host is always connected: nothing provisional to remember. */
export const readLastKnown = <T>(
  _kind: "gate" | "system" | "destination" | "theme"
): T | null => null;
export const writeLastKnown = (
  _kind: "gate" | "system" | "destination" | "theme",
  _value: unknown
) => {};
