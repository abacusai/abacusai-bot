import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mock.transport,
}));
import type { BrowserRuntimeState } from "@abacus-ai/contract/contracts";

import { BrowserTab, NEW_TAB_URL, normalizeAddress } from "./browser-tab";

const state = (resourceId: string, url: string): BrowserRuntimeState => ({
  lease: { conversationKey: "k" as never, resourceId, generation: 1 },
  url,
  title: "Google",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  focused: false,
  crashed: false,
  devToolsOpen: false,
  zoomFactor: 1,
});

it("opens on google.com as its new-tab page, one runtime per tab, no profile picker, and reports the page", async () => {
  const materialize = vi.fn(
    async (input: { resourceId: string; url?: string }) =>
      state(input.resourceId, input.url ?? "about:blank")
  );
  mock.transport = {
    client: {
      browser: { runtime: { materialize }, events: async function* () {} },
    },
  };
  const presenter = {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    register: () => () => {},
    activate: async () => {},
    refresh: async () => {},
  };
  const onState = vi.fn();
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <BrowserTab
        row={{ workspaceId: "w", id: "s" }}
        id="browser:one"
        root="/root"
        visible
        presenter={presenter}
        blocked={() => false}
        onState={onState}
      />
      <BrowserTab
        row={{ workspaceId: "w", id: "s" }}
        id="browser:two"
        url="https://b.test/"
        root="/root"
        visible={false}
        presenter={presenter}
        blocked={() => false}
      />
    </QueryClientProvider>
  );
  await waitFor(() => expect(materialize).toHaveBeenCalledTimes(2));
  expect(materialize).toHaveBeenCalledWith(
    expect.objectContaining({ resourceId: "browser:one", url: NEW_TAB_URL })
  );
  expect(materialize).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceId: "browser:two",
      url: "https://b.test/",
    })
  );
  // i18n is not initialised here: roles, not labels.
  expect(
    (await screen.findAllByRole("textbox")).map(
      (input) => (input as HTMLInputElement).value
    )
  ).toEqual([NEW_TAB_URL, "https://b.test/"]);
  // The multi-profile picker is gone: no select in the bar.
  expect(screen.queryByRole("combobox")).toBeNull();
  await waitFor(() =>
    expect(onState).toHaveBeenCalledWith({ url: NEW_TAB_URL, title: "Google" })
  );
  expect(normalizeAddress("")).toBe(NEW_TAB_URL);
});
