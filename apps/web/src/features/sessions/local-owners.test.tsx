import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";

import type { SessionRow } from "@abacus-ai/contract/contract/rows";
vi.mock("./data/queries", () => ({
  useSessionsTransport: () => ({ client: {} }),
  useWorkspace: () => ({ path: "/repo" }),
  effectiveCheckoutIdentity: () => "checkout",
  useCheckoutWatch: () => {},
  useCheckoutIdentity: () => "checkout",
  useGitState: () => null,
  useCheckoutQueries: () => ({
    tree: () => ({
      queryKey: ["tree"],
      queryFn: async () => ({ fileTree: [] }),
    }),
    search: () => ({
      queryKey: ["search"],
      queryFn: async () => ({ items: [] }),
    }),

    checkoutStatus: () => ({
      queryKey: ["status"],
      queryFn: async () => ({ exists: true, path: "/repo" }),
    }),
  }),
}));
vi.mock("./data/agent-start", () => ({
  useAgentLifecycle: () => ({ observe: () => {}, unavailable: () => {} }),
}));
vi.mock("#renderer/lib/connector-requests", () => ({
  useConnectorRequests: () => ({}),
}));
vi.mock("#renderer/lib/navigation/use-app-navigate", () => ({
  useAppNavigate: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({ file: "selected.pdf" }),
}));
vi.mock("#renderer/components/file-tree", () => ({ FileTreeView: () => null }));
const loading = vi.hoisted(() => {
  let resolveBrowser!: () => void;
  return {
    browser: new Promise<void>((resolve) => {
      resolveBrowser = resolve;
    }),
    resolveBrowser: () => resolveBrowser(),
    browserRequested: vi.fn(),
  };
});
vi.mock("./browser/browser-tab", async () => {
  loading.browserRequested();
  await loading.browser;
  return {
    BrowserTab: ({ id }: { id: string }) => (
      <div data-testid="local-resource" data-resource={id} />
    ),
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./dock/session-dock", () => ({
  SessionDock: ({
    renderTab,
  }: {
    renderTab: (
      tab: { ref: string; path: string },
      visible: boolean,
      onClose: () => void
    ) => ReactNode;
  }) => (
    <>
      {["preview:A", "preview:B", "files"].map((ref) => (
        <div key={ref}>
          {renderTab({ ref, path: `${ref.at(-1)}.pdf` }, true, () => {})}
        </div>
      ))}
    </>
  ),
}));
import { SessionWorkspace } from "./session-workspace";

it("mounted workspace gives each preview and Files viewer a stable distinct local resource", async () => {
  const qc = new QueryClient();
  const props = {
    row: { workspaceId: "w", id: "s" } as SessionRow,
    chat: null,
    incarnation: null,
    renderAgent: () => null,
    renderSession: () => null,
    registerHotkeys: () => null,
    dispatch: () => {},
    presenter: {} as never,
    blocked: () => false,
  };
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <QueryClientProvider client={qc}>
        <SessionWorkspace {...props} />
      </QueryClientProvider>
    );
  });
  const ids = () =>
    [...view.container.querySelectorAll("[data-resource]")].map((node) =>
      node.getAttribute("data-resource")
    );
  expect(ids()).toEqual([]);
  const rerender = () =>
    act(async () => {
      view.rerender(
        <QueryClientProvider client={qc}>
          <SessionWorkspace {...props} row={{ ...props.row }} />
        </QueryClientProvider>
      );
    });
  expect(view.getByRole("status").textContent).toBe("common.loading");
  await rerender();
  expect(ids()).toEqual([]);
  await waitFor(() => expect(loading.browserRequested).toHaveBeenCalled());
  expect(ids()).toEqual([]);
  await rerender();
  expect(ids()).toEqual([]);
  await act(async () => {
    loading.resolveBrowser();
  });
  const resources = await view.findAllByTestId("local-resource");
  expect(resources).toHaveLength(3);
  const first = ids();
  expect(first).toEqual([
    "file-s-preview:A",
    "file-s-preview:B",
    "file-s-files",
  ]);
  expect(new Set(first).size).toBe(3);
  await rerender();
  expect(ids()).toEqual(first);
  view.getAllByTestId("local-resource").forEach((resource, index) => {
    expect(resource).toBe(resources[index]);
  });
  view.unmount();
  qc.clear();
});
