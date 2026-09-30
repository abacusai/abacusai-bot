/**
 * The thread this document shows in its pane (spec 01 §7.8 "never while the
 * causing thread is visible and the window focused"; 03 §6.7). A chat route
 * marks its thread while mounted; unread, cues and notifications read it.
 */
import { Store } from "@tanstack/react-store";
import { useEffect } from "react";

export const visibleThreadStore = new Store<string | null>(null);

/** Mark `threadId` as the pane's thread while the caller is mounted. */
export const useVisibleThread = (threadId: string | null): void => {
  useEffect(() => {
    if (threadId == null) return;
    visibleThreadStore.setState(() => threadId);
    return () =>
      visibleThreadStore.setState((current) =>
        current === threadId ? null : current
      );
  }, [threadId]);
};

const windowFocused = (): boolean =>
  typeof document !== "undefined" && document.hasFocus();

/** `threadId` is on screen in a focused window. */
export const isThreadSeen = (
  threadId: string,
  focused: () => boolean = windowFocused
): boolean => visibleThreadStore.state === threadId && focused();
