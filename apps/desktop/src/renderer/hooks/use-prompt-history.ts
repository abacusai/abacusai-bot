import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The composer's up-arrow history, with shell rules: up walks back, down walks
 * forward, and stepping past the newest entry restores the unsent draft. The
 * list lives in the main process under the profile's home directory, which is
 * what keeps it per profile.
 */
export interface PromptHistory {
  /** Step back. Returns the text to show, or null when there is no more. */
  previous: (current: string) => string | null;
  /** Step forward, ending at the draft that was in the box. */
  next: () => string | null;
  /** Leave history; called when the user types rather than navigates. */
  reset: () => void;
  remember: (prompt: string) => void;
  /** Whether the composer is showing a history entry. */
  browsing: boolean;
  size: number;
}

// `scope` is the session id or the workspace's new-session box. Changing it
// swaps the list and ends any walk: arrows must never surface another chat.
export const usePromptHistory = (scope: string): PromptHistory => {
  const [entries, setEntries] = useState<string[]>([]);
  // -1 is "not browsing"; 0 is the most recent prompt.
  const indexRef = useRef(-1);
  const draftRef = useRef("");
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    indexRef.current = -1;
    draftRef.current = "";
    setBrowsing(false);
    setEntries([]);
    void window.api.agent
      .listPromptHistory?.(scope)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        // No history is a working composer with nothing to walk back through.
      });

    return () => {
      cancelled = true;
    };
  }, [scope]);

  const reset = useCallback((): void => {
    indexRef.current = -1;
    draftRef.current = "";
    setBrowsing(false);
  }, []);

  const previous = useCallback(
    (current: string): string | null => {
      if (entries.length === 0) return null;
      // First step in: keep the draft so stepping back out returns it.
      if (indexRef.current === -1) draftRef.current = current;
      const nextIndex = Math.min(indexRef.current + 1, entries.length - 1);
      if (nextIndex === indexRef.current && indexRef.current !== -1) {
        return null;
      }
      indexRef.current = nextIndex;
      setBrowsing(true);

      return entries[nextIndex] ?? null;
    },
    [entries]
  );

  const next = useCallback((): string | null => {
    if (indexRef.current <= -1) return null;
    const nextIndex = indexRef.current - 1;
    indexRef.current = nextIndex;
    if (nextIndex === -1) {
      setBrowsing(false);

      return draftRef.current;
    }

    return entries[nextIndex] ?? null;
  }, [entries]);

  const remember = useCallback(
    (prompt: string): void => {
      reset();
      void window.api.agent
        .addPromptHistory?.(scope, prompt)
        .then((list) => setEntries(list))
        .catch(() => {
          // A history that cannot be written must never fail the send.
        });
    },
    [reset, scope]
  );

  return { previous, next, reset, remember, browsing, size: entries.length };
};
