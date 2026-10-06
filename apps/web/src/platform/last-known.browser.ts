/**
 * What the browser remembers per user between visits (spec 09 D12): the
 * sign-in gate's flags, the host's system facts and the boot look
 * (lib/theme.ts: the last applied look and the prefs it came from), keyed by the user's host
 * so two accounts in one profile never share them. Only answers from the host
 * are written; nothing assumed at boot is.
 */
import { hostIdentity } from "#renderer/features/shell/connect/services";
import type { LookStore } from "#renderer/lib/theme";

const keyOf = (kind: string): string | null => {
  const id = hostIdentity()?.deploymentConversationId;
  return id == null ? null : `abacusai-bot:last-known:${kind}:${id}`;
};

export const readLastKnown = <T>(
  kind: "gate" | "system" | "destination" | "look"
): T | null => {
  const key = keyOf(kind);
  if (key == null) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
};

export const writeLastKnown = (
  kind: "gate" | "system" | "destination" | "look",
  value: unknown
): void => {
  const key = keyOf(kind);
  if (key == null) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or blocked storage only costs the next visit its head start.
  }
};

/** The boot look's store (lib/theme.ts `setLookStore`): this user's record. */
export const lookStore: LookStore = {
  read: () => readLastKnown("look"),
  write: (value) => writeLastKnown("look", value),
};
