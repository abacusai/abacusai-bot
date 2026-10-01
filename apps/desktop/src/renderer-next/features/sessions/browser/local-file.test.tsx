import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import { render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mock.transport,
}));
import type { BrowserRuntimeLease } from "#shared/contracts";

import { BrowserTab } from "./browser-tab";
it("independent local-file owners materialize separately and close their own leases", async () => {
  const close = vi.fn(async (_lease: BrowserRuntimeLease) => {});
  const materializeFile = vi.fn(async (input) => ({
    lease: {
      conversationKey: input.conversationKey,
      resourceId: input.resourceId,
      generation: 1,
    },
    url: input.filePath,
  }));
  const events = async function* () {
    yield* [];
  };
  mock.transport = {
    client: { browser: { runtime: { materializeFile, close }, events } },
    orpc: {
      browser: {
        profiles: {
          list: {
            queryOptions: () => ({
              queryKey: ["profiles"],
              queryFn: async () => [],
            }),
          },
        },
      },
    },
  };
  const presenter = {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    register: () => () => {},
    activate: async () => {},
    refresh: async () => {},
  };
  const props = {
    row: { workspaceId: "w", id: "s" },
    root: "/root",
    file: "/root/a.pdf",
    visible: true,
    presenter,
    blocked: () => false,
  };
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <BrowserTab {...props} id="files-owner" />
      <BrowserTab {...props} id="preview-owner" file="/root/b.html" />
    </QueryClientProvider>
  );
  await waitFor(() => expect(materializeFile).toHaveBeenCalledTimes(2));
  view.unmount();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(close.mock.calls.map(([lease]) => lease.resourceId).sort()).toEqual([
    "files-owner",
    "preview-owner",
  ]);
  qc.clear();
});
