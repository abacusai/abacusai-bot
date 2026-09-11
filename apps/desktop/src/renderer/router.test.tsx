import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./app", () => ({
  default: () => (
    <div data-testid="app-root">
      <Outlet />
    </div>
  ),
}));

vi.mock("./components/layout/workspace-view", () => ({
  WorkspaceView: ({ mainContent }: { mainContent?: ReactNode }) => (
    <div data-testid="workspace-view">{mainContent ?? "Coding workspace"}</div>
  ),
}));

vi.mock("./components/chat/chat-panel", () => ({
  ChatPanel: () => <div data-testid="chat-panel">Chat</div>,
}));

vi.mock("./components/routines/routine-page", () => ({
  RoutinePage: ({ routineId }: { routineId: string }) => (
    <div data-testid="routine-page">{routineId}</div>
  ),
}));

vi.mock("./components/settings/profile-panel", () => ({
  ProfilePanel: () => <div data-testid="profile-panel">Profile</div>,
}));

vi.mock("./components/settings/capabilities-panel", () => ({
  ToolsPanel: () => <div data-testid="tools-panel">Tools</div>,
  ToolsetPanel: ({ toolset }: { toolset: { id: string } }) => (
    <div data-testid="toolset-panel">{toolset.id}</div>
  ),
}));

vi.mock("./components/settings/connectors-panel", () => ({
  ConnectorsPanel: () => <div data-testid="connectors-panel">Connectors</div>,
}));

vi.mock("./components/skills/skills-management-panel", () => ({
  SkillsManagementPanel: () => <div data-testid="skills-panel">Skills</div>,
}));

vi.mock("./components/mcp/mcp-management-panel", () => ({
  McpManagementPanel: () => <div data-testid="mcp-panel">MCP</div>,
}));

vi.mock("./components/settings/memory-panel", () => ({
  MemoryPanel: () => <div data-testid="memory-panel">Memory</div>,
}));

vi.mock("./components/settings/usage-panel", () => ({
  UsagePanel: () => <div data-testid="usage-panel">Usage</div>,
}));

vi.mock("./components/workspace/artifacts-panel", () => ({
  ArtifactsPanel: () => <div data-testid="artifacts-panel">Artifacts</div>,
}));

vi.mock("./hooks/use-workspace-queries", () => ({
  allAgentSessionsQueryOptions: () => ({
    queryKey: ["all-agent-sessions"],
    queryFn: async () => [],
  }),
  sessionArtifactsQueryOptions: () => ({
    queryKey: ["session-artifacts"],
    queryFn: async () => [],
  }),
  workspaceMetadataQueryOptions: () => ({
    queryKey: ["workspace-metadata"],
    queryFn: async () => ({ activeWorkspaceId: null, workspaces: [] }),
  }),
}));

const { createAppRouter } = await import("./router");
const { useWorkspaceStore } = await import("./stores/code-store");

const renderRoute = (entry: string | string[]) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const history = createMemoryHistory({
    initialEntries: Array.isArray(entry) ? entry : [entry],
  });
  const router = createAppRouter(queryClient, history);
  const rendered = render(<RouterProvider router={router} />);
  return { ...rendered, history, queryClient, router };
};

describe("renderer route families", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ activeRightTab: "explorer" });
  });

  it("opens a routine's page beside the lists, by its id", async () => {
    const { getByTestId } = renderRoute("/routines/job-42");

    await waitFor(() => expect(getByTestId("routine-page")).toBeTruthy());
    expect(getByTestId("routine-page").textContent).toBe("job-42");
    expect(getByTestId("workspace-view")).toBeTruthy();
  });

  it("keeps the coding route inside WorkspaceView and applies its search", async () => {
    const { getByTestId, queryByTestId } = renderRoute(
      "/?view=chat&panel=preview&capabilities=mcp&diff=split"
    );

    await waitFor(() => expect(getByTestId("workspace-view")).toBeTruthy());
    expect(queryByTestId("capabilities-panel")).toBeNull();
    expect(
      document.querySelector('[data-slot="focused-tool-layout"]')
    ).toBeNull();

    await waitFor(() => {
      expect(useWorkspaceStore.getState().activeRightTab).toBe("preview");
    });
  });

  it("forwards a legacy main-view search to the pane that replaced it", async () => {
    const { getByTestId } = renderRoute(
      "/?view=usage&panel=preview&capabilities=mcp&diff=split"
    );

    await waitFor(() => expect(getByTestId("usage-panel")).toBeTruthy());
    // In the pane, so the session list is still there to click.
    expect(getByTestId("workspace-view")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="focused-tool-layout"]')
    ).toBeNull();
  });

  it("renders the profile in the pane, not a window of its own", async () => {
    // It used to swap the whole window for the focused settings shell, which
    // took the sidebar and the chat behind it with it. Memory and usage never
    // did that, and there was never a reason these four should. Notifications,
    // devices and the browser moved with it — they share this route's parent,
    // and their panels need the preload bridge to render enough to assert on.
    const { getByTestId } = renderRoute("/settings/account");

    await waitFor(() => expect(getByTestId("profile-panel")).toBeTruthy());
    expect(getByTestId("workspace-view")).toBeTruthy();
    expect(
      document.querySelector('[data-slot="focused-tool-layout"]')
    ).toBeNull();
  });

  it("preloads artifact data through the route loader", async () => {
    const { getByTestId, queryClient } = renderRoute("/settings/artifacts");

    await waitFor(() => expect(getByTestId("artifacts-panel")).toBeTruthy());
    expect(getByTestId("workspace-view")).toBeTruthy();
    expect(queryClient.getQueryData(["session-artifacts"])).toEqual([]);
    expect(queryClient.getQueryData(["all-agent-sessions"])).toEqual([]);
  });

  it("lands a bare /settings on the profile, in the pane", async () => {
    // The redirect outlived the focused shell it was written for: there is no
    // settings window to open any more, so /settings is just the profile page.
    const { getByTestId } = renderRoute("/settings");

    await waitFor(() => expect(getByTestId("profile-panel")).toBeTruthy());
    expect(getByTestId("workspace-view")).toBeTruthy();
  });

  it("walks back out of a toolset without leaving the pane", async () => {
    const { getByTestId } = renderRoute("/settings/tools/terminal");

    await waitFor(() => expect(getByTestId("toolset-panel")).toBeTruthy());
    // Still inside the coding shell, which is the whole point of the move.
    expect(getByTestId("workspace-view")).toBeTruthy();

    fireEvent.click(
      document.querySelector(
        '[data-id="capabilities-pane-back"]'
      ) as HTMLElement
    );
    await waitFor(() => expect(getByTestId("tools-panel")).toBeTruthy());
    expect(
      document.querySelector('[data-id="capabilities-pane-back"]')
    ).toBeNull();
  });

  it("keeps the coding shell mounted behind the capabilities tabs", async () => {
    const { getByTestId, queryByTestId } = renderRoute("/settings/skills");

    await waitFor(() => expect(getByTestId("skills-panel")).toBeTruthy());
    expect(getByTestId("workspace-view")).toBeTruthy();
    expect(
      document.querySelector('[data-id="capabilities-pane"]')
    ).toBeTruthy();
    expect(
      document.querySelector('[data-slot="focused-tool-layout"]')
    ).toBeNull();
    expect(queryByTestId("focused-title")).toBeNull();
  });
});
