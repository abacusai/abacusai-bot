/**
 * What the browser remembers per user between visits (spec 09 D12): the
 * sign-in gate's flags and the host's system facts, keyed by the user's host
 * so two accounts in one profile never share them. Only answers from the host
 * are written; nothing assumed at boot is.
 */
import { hostIdentity } from "#renderer/features/shell/connect/services";

const keyOf = (kind: string): string | null => {
  const id = hostIdentity()?.deploymentConversationId;
  return id == null ? null : `abacusai-bot:last-known:${kind}:${id}`;
};

export const readLastKnown = <T>(
  kind: "gate" | "system" | "destination" | "theme"
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
  kind: "gate" | "system" | "destination" | "theme",
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
