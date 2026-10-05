import { Store, useStore } from "@tanstack/react-store";

import { IS_ELECTRON } from "#renderer/lib/platform";

export interface BrowserOpenRequest {
  sessionId: string;
  url: string;
}
const requests = new Store<Record<string, string>>({});
let handler: ((request: BrowserOpenRequest) => void) | null = null;

/** @public Phase 4 registers its session browser surface here. */
export const registerBrowserOpen = (
  next: (request: BrowserOpenRequest) => void
): (() => void) => {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
};
export const requestBrowserOpen = (request: BrowserOpenRequest): void => {
  if (!IS_ELECTRON) {
    window.open(request.url, "_blank", "noopener,noreferrer");
    return;
  }
  requests.setState((state) => ({
    ...state,
    [request.sessionId]: request.url,
  }));
  handler?.(request);
};
export const useBrowserOpenUrl = (sessionId: string): string | undefined =>
  useStore(requests, (state) => state[sessionId]);
