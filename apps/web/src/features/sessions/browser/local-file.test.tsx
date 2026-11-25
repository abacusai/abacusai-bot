import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { i18n } from "#renderer/lib/i18n";
const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mock.transport,
}));
import type { BrowserRuntimeState } from "@abacus-ai/contract/contracts";

import { BrowserTab } from "./browser-tab";

// The page's words come from the app's copy: load it, without the React
// binding, so this test's keys still read as keys.
beforeAll(() =>
  i18n.init({ resources: { "en-US": { translation: enUS } }, lng: "en-US" })
);
const profiles = {
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
};
const idlePresenter = () => ({
  captures: new Store<Record<string, string>>({}),
  owner: new Store<string | null>(null),
  register: () => () => {},
  activate: async () => {},
  refresh: async () => {},
});
type Held = { resourceId: string; holder: string };

it("each local-file viewer holds the runtime in main and releases only its own hold", async () => {
  const close = vi.fn(async () => {});
  const release = vi.fn(async (_input: Held) => {});
  const materializeFile = vi.fn(async (input) => ({
    lease: {
      conversationKey: input.conversationKey,
      resourceId: input.resourceId,
      generation: 1,
    },
    url: input.filePath,
  }));
  mock.transport = {
    client: {
      browser: {
        runtime: { materializeFile, close, release },
        events: async function* () {},
      },
    },
    orpc: profiles,
  };
  const props = {
    row: { workspaceId: "w", id: "s" },
    root: "/root",
    file: "/root/a.pdf",
    visible: true,
    presenter: idlePresenter(),
    blocked: () => false,
  };
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <BrowserTab {...props} id="shared" />
      <BrowserTab {...props} id="shared" />
    </QueryClientProvider>
  );
  await waitFor(() => expect(materializeFile).toHaveBeenCalledTimes(2));
  const holders = materializeFile.mock.calls.map(([input]) => input.holder);
  expect(new Set(holders).size).toBe(2);
  view.rerender(
    <QueryClientProvider client={qc}>
      <BrowserTab {...props} id="shared" />
    </QueryClientProvider>
  );
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  // The other tab keeps its hold; the renderer never closes a shared view.
  expect(close).not.toHaveBeenCalled();
  view.unmount();
  await waitFor(() => expect(release).toHaveBeenCalledTimes(2));
  expect(release.mock.calls.map(([input]) => input.holder).sort()).toEqual(
    [...holders].sort()
  );
  expect(close).not.toHaveBeenCalled();
  qc.clear();
});

it("releases a hold only once its acquire has landed", async () => {
  let complete!: (state: BrowserRuntimeState) => void;
  const materializeFile = vi.fn(
    () =>
      new Promise<BrowserRuntimeState>((resolve) => {
        complete = resolve;
      })
  );
  const release = vi.fn(async () => {});
  mock.transport = {
    client: {
      browser: {
        runtime: { materializeFile, release, close: vi.fn() },
        events: async function* () {},
      },
    },
    orpc: profiles,
  };
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <BrowserTab
        row={{ workspaceId: "w", id: "s" }}
        id="slow"
        root="/root"
        file="/root/a.pdf"
        visible
        presenter={idlePresenter()}
        blocked={() => false}
      />
    </QueryClientProvider>
  );
  await waitFor(() => expect(materializeFile).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => {});
  expect(release).not.toHaveBeenCalled();
  await act(async () => {
    complete({
      lease: { conversationKey: "k", resourceId: "slow", generation: 1 },
      url: "file:///root/a.pdf",
    } as BrowserRuntimeState);
  });
  await waitFor(() => expect(release).toHaveBeenCalledOnce());
  qc.clear();
});

it("a present that fails shows the tab's error with Retry, which acquires again", async () => {
  const materializeFile = vi.fn(async (input) => ({
    lease: {
      conversationKey: input.conversationKey,
      resourceId: input.resourceId,
      generation: 1,
    },
    url: input.filePath,
  }));
  mock.transport = {
    client: {
      browser: {
        runtime: { materializeFile, release: vi.fn(async () => {}) },
        events: async function* () {},
      },
    },
    orpc: profiles,
  };
  let fail = true;
  const presenter = {
    ...idlePresenter(),
    register: (candidate: {
      lease: BrowserRuntimeState["lease"];
      failed?(error: unknown): void;
      presented?(state: BrowserRuntimeState): void;
    }) => {
      queueMicrotask(() =>
        fail
          ? candidate.failed?.(
              new Error("Browser runtime r is closed or does not exist")
            )
          : candidate.presented?.({
              lease: candidate.lease,
            } as BrowserRuntimeState)
      );
      return () => {};
    },
  };
  const onDraw = vi.fn();
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <BrowserTab
        row={{ workspaceId: "w", id: "s" }}
        id="r"
        root="/root"
        file="/root/a.pdf"
        visible
        presenter={presenter}
        blocked={() => false}
        onDraw={onDraw}
      />
    </QueryClientProvider>
  );
  const alert = await view.findByRole("alert");
  expect(onDraw).toHaveBeenLastCalledWith("failed");
  expect(alert.textContent).toContain("Something went wrong. Try again.");
  expect(alert.textContent).not.toContain("is closed");
  expect(
    view.queryByRole("region", { name: "sessions.browser.title" })
  ).toBeNull();
  fail = false;
  fireEvent.click(view.getByRole("button", { name: "sessions.common.retry" }));
  await waitFor(() => expect(materializeFile).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.queryByRole("alert")).toBeNull());
  expect(
    view.getByRole("region", { name: "sessions.browser.title" })
  ).toBeTruthy();
  await waitFor(() => expect(onDraw).toHaveBeenLastCalledWith("drawn"));
  view.unmount();
  qc.clear();
});
