import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import { act, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mock.transport,
}));
import type {
  BrowserRuntimeLease,
  BrowserRuntimeState,
} from "@abacus-ai/contract/contracts";

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

it.each([false, true])(
  "keeps a shared local lease across a dock-leaf remount, settled=%s",
  async (settled) => {
    let complete!: (state: BrowserRuntimeState) => void;
    const pending = new Promise<BrowserRuntimeState>((resolve) => {
      complete = resolve;
    });
    const materializeFile = vi.fn(() => pending);
    const close = vi.fn(async () => {});
    mock.transport = {
      client: {
        browser: {
          runtime: { materializeFile, close },
          events: async function* () {},
        },
      },
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
    const props = {
      row: { workspaceId: "w", id: "s" },
      id: "moving-preview",
      root: "/root",
      file: "/root/a.pdf",
      visible: true,
      presenter: {
        captures: new Store<Record<string, string>>({}),
        owner: new Store<string | null>(null),
        register: () => () => {},
        activate: async () => {},
        refresh: async () => {},
      },
      blocked: () => false,
    };
    const state = {
      lease: {
        conversationKey: "session:w:s",
        resourceId: props.id,
        generation: 1,
      },
      url: props.file,
    } as BrowserRuntimeState;
    const qc = new QueryClient();
    const tree = (leaf: string, show = true, twin = false) => (
      <QueryClientProvider client={qc}>
        <div key={leaf}>
          {show ? <BrowserTab {...props} /> : null}
          {twin ? <BrowserTab {...props} /> : null}
        </div>
      </QueryClientProvider>
    );
    const view = render(tree("first-leaf"));
    try {
      await waitFor(() => expect(materializeFile).toHaveBeenCalledOnce());
      if (settled)
        await act(async () => {
          complete(state);
        });
      view.rerender(tree("second-leaf"));
      await act(async () => {
        complete(state);
      });
      await waitFor(() =>
        expect(
          view.queryByRole("region", { name: "sessions.browser.title" })
        ).not.toBeNull()
      );
      expect(close).not.toHaveBeenCalled();
      view.rerender(tree("second-leaf", true, true));
      await act(async () => {});
      view.rerender(tree("second-leaf", false, true));
      await act(async () => {});
      expect(close).not.toHaveBeenCalled();
      view.rerender(tree("second-leaf", false));
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(close).toHaveBeenCalledWith(state.lease);
    } finally {
      view.unmount();
      qc.clear();
    }
  }
);
