import { IS_ELECTRON } from "#renderer/lib/platform";

export interface BrowserOpenRequest {
  sessionId: string;
  url: string;
}
let handler: ((request: BrowserOpenRequest) => void) | null = null;

/**
 * @public The session's browser registration listens here; a bot chat's
 * opens a browser tab in the bot's panel (`routes/(bots)/-browser`).
 */
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
  handler?.(request);
};
