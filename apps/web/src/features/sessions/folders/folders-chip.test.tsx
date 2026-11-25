/** The Folders control lists the chat's own folder and the added ones, adds by picker, removes by row. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ transport: {} as any }));
vi.mock("../data/queries", async (original) => ({
  ...(await original<typeof import("../data/queries")>()),
  useSessionsTransport: () => mock.transport,
}));
vi.mock("#renderer/lib/platform-system", () => ({
  platformSystem: () => ({
    dialog: { openFolder: async () => "/Users/dev/Drive/site" },
  }),
}));

import { FoldersMenu } from "./folders-chip";

it("adds a picked folder and removes an added one; the chat's own folder stays", async () => {
  const add = vi.fn(async () => ({ folders: [] }));
  const remove = vi.fn(async () => ({ folders: [] }));
  mock.transport = {
    client: { sessions: { folders: { add, remove } } },
    orpc: { browser: { runtime: { previewRoot: { key: () => ["p"] } } } },
  };
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <FoldersMenu
        sessionId="s"
        chatFolder="/s/session-home"
        folders={["/Users/dev/Downloads"]}
      />
    </QueryClientProvider>
  );
  fireEvent.click(view.getByRole("button", { name: "sessions.folders.label" }));
  await view.findByText("/s/session-home");
  expect(view.getByText("/Users/dev/Downloads")).toBeTruthy();
  // One remove button: the added folder's, never the chat's own.
  const removes = view.getAllByRole("button", {
    name: "sessions.folders.remove",
  });
  expect(removes).toHaveLength(1);
  fireEvent.click(removes[0]!);
  fireEvent.click(
    view.getByRole("button", { name: "sessions.folders.addOther" })
  );
  await waitFor(() =>
    expect(add).toHaveBeenCalledWith({
      sessionId: "s",
      path: "/Users/dev/Drive/site",
    })
  );
  expect(remove).toHaveBeenCalledWith({
    sessionId: "s",
    path: "/Users/dev/Downloads",
  });
  view.unmount();
});
