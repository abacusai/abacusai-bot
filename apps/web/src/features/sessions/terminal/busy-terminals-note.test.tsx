import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { expect, it, vi } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";

const busyIn = vi.fn();
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => ({
    orpc: {
      terminal: {
        busyIn: {
          queryOptions: ({ input }: { input: unknown }) => ({
            queryKey: ["terminal.busyIn", input],
            queryFn: () => busyIn(input),
          }),
        },
      },
    },
  }),
}));

import { openTab } from "../dock/panel-tabs-store";
import { BusyTerminalsNote } from "./busy-terminals-note";

const key = '["conversation",1,"w","session","s"]';
const show = (props: { workspaceId: string; sessionId?: string }) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <BusyTerminalsNote {...props} />
      </I18nextProvider>
    </QueryClientProvider>
  );

it("names what deleting a session stops, or the terminals it closes where programs are unknown", async () => {
  await initI18n();
  openTab(key, { ref: "terminal:t1", title: "Dev server" });
  busyIn.mockResolvedValueOnce([
    {
      conversationKey: key,
      terminalId: "t1",
      program: "sleep",
      chat: "Fix it",
    },
  ]);
  const view = show({ workspaceId: "w", sessionId: "s" });
  expect(
    await screen.findByText(
      "Deleting this session stops what's running in its terminals: sleep."
    )
  ).toBeTruthy();
  view.unmount();

  // Windows: every open terminal, by its tab, in the workspace's chats.
  busyIn.mockResolvedValueOnce([
    { conversationKey: key, terminalId: "t1", program: null, chat: "Fix it" },
  ]);
  const workspace = show({ workspaceId: "w" });
  expect(
    await screen.findByText(
      "Deleting this workspace closes its open terminals: Dev server in Fix it."
    )
  ).toBeTruthy();
  workspace.unmount();
});

it("says nothing when nothing would stop", async () => {
  await initI18n();
  busyIn.mockResolvedValueOnce([]);
  const view = show({ workspaceId: "w", sessionId: "s" });
  await vi.waitFor(() => expect(busyIn).toHaveBeenCalled());
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
});
