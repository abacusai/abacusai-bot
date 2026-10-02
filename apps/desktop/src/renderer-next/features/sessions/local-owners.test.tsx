import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { SessionRow } from "#shared/contract/rows";
vi.mock("./data/queries", () => ({
  useSessionsTransport: () => ({ client: {} }),
  useWorkspace: () => ({ path: "/repo" }),
  effectiveCheckoutIdentity: () => "checkout",
  useCheckoutWatch: () => {},
  useCheckoutQueries: () => ({
    checkoutStatus: () => ({
      queryKey: ["status"],
      queryFn: async () => ({ exists: true, path: "/repo" }),
    }),
  }),
}));
vi.mock("./data/agent-start", () => ({
  useAgentLifecycle: () => ({ observe: () => {}, unavailable: () => {} }),
}));
vi.mock("#next/lib/connector-requests", () => ({
  useConnectorRequests: () => ({}),
}));
vi.mock("#next/lib/navigation/use-app-navigate", () => ({
  useAppNavigate: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({}) }));
vi.mock("./dock/session-dock", () => ({
  SessionDock: ({ renderTab }: any) => (
    <>
      {["preview:A", "preview:B", "files"].map((ref) => (
        <div key={ref}>
          {renderTab({ ref, path: `${ref.at(-1)}.pdf` }, true, () => {})}
        </div>
      ))}
    </>
  ),
}));
vi.mock("./files/files-tab", () => ({
  SessionFilePreview: ({ path, root, renderLocal }: any) =>
    renderLocal(`${root}/${path}`),
  FilesTab: ({ renderLocal }: any) => renderLocal("/repo/selected.pdf"),
}));
vi.mock("./browser/browser-tab", () => ({
  BrowserTab: ({ id }: { id: string }) => <div data-resource={id} />,
}));
import { SessionWorkspace } from "./session-workspace";
it("mounted workspace gives each preview and Files viewer a stable distinct local resource", () => {
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
  const view = render(
    <QueryClientProvider client={qc}>
      <SessionWorkspace {...props} />
    </QueryClientProvider>
  );
  const ids = () =>
    [...view.container.querySelectorAll("[data-resource]")].map((node) =>
      node.getAttribute("data-resource")
    );
  const first = ids();
  expect(new Set(first).size).toBe(3);
  view.rerender(
    <QueryClientProvider client={qc}>
      <SessionWorkspace {...props} row={{ ...props.row }} />
    </QueryClientProvider>
  );
  expect(ids()).toEqual(first);
  view.unmount();
  qc.clear();
});
