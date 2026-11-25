import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Store } from "@tanstack/react-store";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => mock.transport,
}));
const opened = vi.hoisted(() => ({ openHostPath: vi.fn(async () => {}) }));
vi.mock("#renderer/lib/open-host-path", () => opened);

import { BrowserTab } from "./browser-tab";

const presenter = () => ({
  captures: new Store<Record<string, string>>({}),
  owner: new Store<string | null>(null),
  register: () => () => {},
  activate: async () => {},
  refresh: async () => {},
});

const renderRefusing = (error: unknown) => {
  const materializeFile = vi.fn(async () => {
    throw error;
  });
  mock.transport = {
    client: {
      browser: {
        runtime: { materializeFile, release: vi.fn(async () => {}) },
        events: async function* () {},
      },
    },
    orpc: {
      browser: {
        profiles: {
          list: {
            queryOptions: () => ({ queryKey: ["p"], queryFn: async () => [] }),
          },
        },
      },
    },
  };
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <BrowserTab
        row={{ workspaceId: "w", id: "s" }}
        id="page"
        root="/checkout"
        file="/elsewhere/site/index.html"
        visible
        presenter={presenter()}
        blocked={() => false}
      />
    </QueryClientProvider>
  );
};

it.each(["outside-root", "root-not-allowed"])(
  "a file main will not preview (%s) gets a calm note and opens in its own app",
  async (reason) => {
    const view = renderRefusing(
      new ORPCError("FORBIDDEN", { defined: true, data: { reason } })
    );
    const note = await view.findByRole("status");
    expect(note.textContent).toContain("sessions.browser.outsideFolders");
    expect(view.queryByRole("alert")).toBeNull();
    fireEvent.click(
      view.getByRole("button", { name: "bots.chat.preview.openExternally" })
    );
    await waitFor(() =>
      expect(opened.openHostPath).toHaveBeenCalledWith(
        mock.transport.client,
        "/elsewhere/site/index.html"
      )
    );
    view.unmount();
  }
);

it("any other failure keeps the tab's error with Retry", async () => {
  const view = renderRefusing(
    new ORPCError("FORBIDDEN", {
      defined: true,
      data: { reason: "unsupported-type" },
    })
  );
  await view.findByRole("alert");
  expect(view.queryByText("sessions.browser.outsideFolders")).toBeNull();
  expect(
    view.getByRole("button", { name: "sessions.common.retry" })
  ).toBeTruthy();
  view.unmount();
});
