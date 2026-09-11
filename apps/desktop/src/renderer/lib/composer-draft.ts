import { durableStorage } from "./durable-storage";

const COMPOSER_DRAFT_PREFIX = "composer.draft";

export function composerDraftKey(workspaceId: string): string {
  return `${COMPOSER_DRAFT_PREFIX}:${workspaceId}`;
}

export function readComposerDraft(workspaceId: string): string {
  try {
    return durableStorage.getItem(composerDraftKey(workspaceId)) ?? "";
  } catch {
    return "";
  }
}

export function writeComposerDraft(workspaceId: string, value: string): void {
  try {
    const key = composerDraftKey(workspaceId);
    if (value.length === 0) durableStorage.removeItem(key);
    else durableStorage.setItem(key, value);
  } catch {
    // Draft persistence must never block typing.
  }
}

/** A workspace's new-session box, as opposed to an open session's. */
export function isNewSessionComposerKey(key: string): boolean {
  return key.startsWith("workspace:");
}

/**
 * What the composer shows when its identity changes, and what to store. The
 * box is keyed by what the next send belongs to; text typed in a new-session
 * box moves with it once the folder is chosen, text typed in a session never
 * follows the user into another chat. `current` is the only copy while the
 * box has no key.
 */
export function composerDraftForKeyChange({
  previousKey,
  nextKey,
  current,
  read = readComposerDraft,
}: {
  previousKey: string | null;
  nextKey: string | null;
  current: string;
  read?: (key: string) => string;
}): { value: string; writes: [key: string, value: string][] } {
  if (nextKey == null) return { value: "", writes: [] };

  const stored = read(nextKey);
  if (stored.length > 0) return { value: stored, writes: [] };
  if (!isNewSessionComposerKey(nextKey)) return { value: "", writes: [] };

  // No key is where a new session pane starts (typing before choosing the
  // folder), so it carries like any other new-session identity.
  const carries = previousKey == null || isNewSessionComposerKey(previousKey);
  if (!carries || current.length === 0) return { value: "", writes: [] };

  const writes: [string, string][] = [];
  if (previousKey != null) writes.push([previousKey, ""]);
  writes.push([nextKey, current]);
  return { value: current, writes };
}
