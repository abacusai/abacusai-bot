import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  set: vi.fn(async () => ({
    selected: "docker",
    effective: "docker",
    statuses: [],
  })),
}));
vi.mock("#renderer/data/db", () => ({
  useDb: () => ({
    collections: { workspaces: { utils: { resync: vi.fn() } } },
    updatePrefs: vi.fn(),
  }),
}));
vi.mock("../data/queries", () => {
  const option = (key: string, data: unknown) => () => ({
    queryKey: [key],
    queryFn: async () => data,
  });
  return {
    useSessionsTransport: () => ({
      client: {
        settings: { execBackend: { set: mocks.set } },
        system: { dialog: { openFolder: vi.fn() }, openExternal: vi.fn() },
        workspaces: { add: vi.fn() },
      },
    }),
    usePickableWorkspaces: () => [],
    useWorkspace: () => ({ label: "Workspace" }),
    useCheckoutQueries: () => ({
      branch: option("branch", null),
      pr: option("pr", null),
      worktrees: option("trees", null),
      exec: option("exec", {
        selected: "local",
        effective: "local",
        statuses: [
          { id: "local", ready: true },
          { id: "docker", ready: true },
        ],
      }),
    }),
  };
});
import { initI18n } from "#renderer/lib/i18n";

import { SessionContextTray } from "./context-tray";
it("idle running agents lock both the backend trigger and an already-open picker", async () => {
  await initI18n();
  const qc = new QueryClient();
  const view = render(
    <QueryClientProvider client={qc}>
      <SessionContextTray workspaceId="w" busy={false} agentRunning={false} />
    </QueryClientProvider>
  );
  const trigger = await screen.findByRole("button", { name: "Local" });
  fireEvent.click(trigger);
  const docker = await screen.findByRole("button", { name: "Docker" });
  view.rerender(
    <QueryClientProvider client={qc}>
      <SessionContextTray workspaceId="w" busy={false} agentRunning />
    </QueryClientProvider>
  );
  expect((trigger as HTMLButtonElement).disabled).toBe(true);
  expect((docker as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(docker);
  expect(mocks.set).not.toHaveBeenCalled();
  view.rerender(
    <QueryClientProvider client={qc}>
      <SessionContextTray workspaceId="w" busy={false} agentRunning={false} />
    </QueryClientProvider>
  );
  fireEvent.click(docker);
  await waitFor(() =>
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith({ backend: "docker" })
  );
  view.unmount();
  qc.clear();
});

it("renders no PR placeholder and hides the environment control with one available backend", async () => {
  await initI18n();
  const qc = new QueryClient();
  qc.setQueryData(["exec"], {
    selected: "local",
    effective: "local",
    statuses: [
      { id: "local", ready: true },
      { id: "docker", ready: false },
    ],
  });
  const view = render(
    <QueryClientProvider client={qc}>
      <SessionContextTray workspaceId="w" sessionId="s" worktree={{ kind: "current" }} onWorktree={vi.fn()} />
    </QueryClientProvider>
  );
  expect(screen.queryByText("No PR")).toBeNull();
  expect(screen.queryByText("No worktree")).toBeNull();
  expect(screen.queryByRole("button", { name: "New worktree" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Local" })).toBeNull();
  view.unmount();
  qc.clear();
});
