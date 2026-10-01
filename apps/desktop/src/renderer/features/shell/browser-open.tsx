import { useRouter } from "@tanstack/react-router";
import { Store, useStore } from "@tanstack/react-store";
import { useTranslation } from "react-i18next";

import type { Transport } from "#renderer/data/transport";
import { Button } from "#renderer/ui/button";

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
  requests.setState((state) => ({
    ...state,
    [request.sessionId]: request.url,
  }));
  handler?.(request);
};
export const useBrowserOpenUrl = (sessionId: string): string | undefined =>
  useStore(requests, (state) => state[sessionId]);

export const BrowserOpenPlaceholder = ({
  sessionId,
}: {
  sessionId: string;
}) => {
  const url = useStore(requests, (state) => state[sessionId]);
  const transport = (useRouter().options.context as { transport: Transport })
    .transport;
  const { t } = useTranslation();
  if (!url) return null;
  return (
    <div
      className="flex flex-col gap-3 p-4"
      data-slot="browser-open-placeholder"
    >
      <p className="break-all" data-slot="browser-open-url">
        {url}
      </p>
      <Button
        variant="secondary"
        onClick={() => void transport.client.system.openExternal({ url })}
      >
        {t("shell.panel.openExternalBrowser")}
      </Button>
    </div>
  );
};
