import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
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
vi.mock("#renderer/lib/connector-requests", () => ({
  useConnectorRequests: () => ({}),
}));
vi.mock("#renderer/lib/navigation/use-app-navigate", () => ({
  useAppNavigate: () => () => {},
}));
vi.mock("@tanstack/react-router", () => ({ useSearch: () => ({}) }));
vi.mock("./dock/session-dock", () => ({
  // Exercise the viewer's renderLocal contract without resolving its lazy
  // implementation: ownership belongs to the mounted workspace, not the viewer.
  SessionDock: ({ renderTab }: any) => (
    <>
      {["preview:A", "preview:B", "files"].map((ref) => {
        const pane = renderTab(
          { ref, path: `${ref.at(-1)}.pdf` },
          true,
          () => {}
        ) as ReactElement<{
          renderLocal(path: string): ReactElement<{ id: string }>;
        }>;
        const local = pane.props.renderLocal("/repo/selected.pdf");
        return <div key={ref} data-resource={local.props.id} />;
      })}
    </>
  ),
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
