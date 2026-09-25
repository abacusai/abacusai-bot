import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { openPreviewTab } from "../../lib/preview-tabs";
import { setActiveConversationKey } from "../../stores/active-conversation-store";
import {
  browserResourceActions,
  browserResourceStore,
  createBrowserResourceState,
  selectBrowserResourceScope,
  type BrowserResourceId,
} from "../../stores/browser-resource-store";
import { previewActions, previewStore } from "../../stores/preview-store";
import { rightPanelStore } from "../../stores/right-panel-react";
import {
  createRightPanelState,
  rightPanelScopeKey,
} from "../../stores/right-panel-store";
import { SidebarProvider } from "../ui/sidebar";
import { SecondarySidebarPanel } from "./secondary-sidebar-panel";

let subtasks: Array<{ id: string }> = [];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { enabled: false }, isSuccess: true }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        "workspace.agents.emptyHint": "No subagents in this conversation.",
        "workspace.hideRightPanel": "Hide panel",
        "workspace.preview.addSurface": "Add surface",
        "workspace.preview.closeSurface": `Close ${String(values?.title ?? "surface")}`,
        "workspace.rightPanel.agentsDescription":
          "Follow subagents and workflows.",
        "workspace.rightPanel.browser": "Browser",
        "workspace.rightPanel.browserDescription": "Open a local app or URL.",
        "workspace.rightPanel.deviceDescription": "Preview a connected device.",
        "workspace.rightPanel.emptyDescription": "Choose what to show.",
        "workspace.rightPanel.emptyTitle": "Open a surface",
        "workspace.rightPanel.explorerDescription": "Browse workspace files.",
        "workspace.rightPanel.open": "Open",
        "workspace.rightPanel.tabs": "Inspector panels",
        "workspace.rightTab.agents": "Agents",
        "workspace.rightTab.device": "Device",
        "workspace.terminalRequiresWorkspace": "Select a workspace.",
      };
      return labels[key] ?? String(values?.defaultValue ?? key);
    },
  }),
}));

vi.mock("../../conversation", () => ({
  useSubtasks: () => subtasks,
}));

vi.mock("../../providers/workspace-state-provider", () => ({
  useWorkspaceActiveWorkspaceId: () => "workspace-one",
}));

vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        workspaceUiStates: {
          "workspace-one": { activeSessionId: "session-one" },
        },
      }),
    { getState: () => ({ setRightPanelVisible: () => {} }) }
  ),
}));

vi.mock("../browser/preview-panel", () => ({
  PreviewPanel: () => <div data-testid="preview-panel" />,
}));
vi.mock("../browser/browser-runtime-surface", () => ({
  BrowserRuntimeSurface: () => <div data-testid="browser-runtime" />,
}));
vi.mock("../chat/agents-panel", () => ({
  AgentsPanel: () => <div data-testid="agents-panel" />,
}));
vi.mock("../device/device-panel", () => ({
  DevicePanel: () => <div data-testid="device-panel" />,
}));
vi.mock("../workspace/explorer-panel", () => ({
  ExplorerPanel: () => <div data-testid="explorer-panel" />,
}));

const scope = rightPanelScopeKey({
  workspaceId: "workspace-one",
  sessionId: "session-one",
});

const renderPanel = (
  overrides: Partial<React.ComponentProps<typeof SecondarySidebarPanel>> = {}
) => {
  const props = {
    activeTab: "preview" as const,
    onTabChange: vi.fn(),
    onClose: vi.fn(),
    onOpenTerminal: vi.fn(),
    ...overrides,
  };
  render(
    <SidebarProvider>
      <SecondarySidebarPanel {...props} />
    </SidebarProvider>
  );
  return props;
};

const openAddSurfaceMenu = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Add surface" }));
};

beforeEach(() => {
  subtasks = [];
  rightPanelStore.setState(() => createRightPanelState());
  browserResourceStore.setState(() => createBrowserResourceState());
  previewActions.reset();
  setActiveConversationKey(null);
});

describe("secondary sidebar descriptor integration", () => {
  it("clips long tab labels inside the horizontally scrolling strip", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));
    const tab = screen.getByRole("tab");
    expect(tab.className).toContain("overflow-hidden");
    expect(tab.className).toContain("max-w-full");
    expect(tab.parentElement?.className).toContain("overflow-hidden");
    expect(tab.querySelector("span:last-child")?.className).toContain(
      "truncate"
    );
  });

  it("creates a distinct homepage runtime and descriptor for every Browser action", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));
    openAddSurfaceMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Browser" }));

    await waitFor(() => {
      const descriptors =
        rightPanelStore.get().scopes[scope]?.descriptors ?? [];
      expect(
        descriptors.filter(
          (item) => item.kind === "resource" && item.resourceType === "browser"
        )
      ).toHaveLength(2);
    });
    const resources = selectBrowserResourceScope(
      browserResourceStore.get(),
      scope
    );
    expect(resources.resourceIds).toHaveLength(2);
    expect(resources.resourceIds[0]).not.toBe(resources.resourceIds[1]);
    expect(
      resources.resourceIds.map((id) => resources.resources[id]?.url)
    ).toEqual(["https://www.google.com", "https://www.google.com"]);

    const activeId = rightPanelStore.get().scopes[scope]?.activeId;
    act(() => {
      openPreviewTab(scope, {
        resourceId: activeId ?? undefined,
        type: "url",
        location: "https://example.com",
        title: "Example",
      });
    });
    await waitFor(() => {
      expect(
        rightPanelStore
          .get()
          .scopes[scope]?.descriptors.find(({ id }) => id === activeId)
      ).toMatchObject({ resourceType: "browser", title: "Example" });
    });
  });

  it("puts the agent's own browser in the pane before opening a blank one", async () => {
    browserResourceActions.adopt(
      scope,
      "agent-browser" as BrowserResourceId,
      "https://www.google.com/travel/flights"
    );
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));

    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toBe(
        "browser:agent-browser"
      );
    });
    // Nothing new was created for it.
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), scope).resourceIds
    ).toEqual(["agent-browser"]);
  });

  it("keeps the agent's browser tab selected while a screenshot preview is open", async () => {
    // The agent drove its browser to the app, saved a screenshot, and the
    // screenshot was opened in the pane. Clicking back onto the browser tab
    // used to do nothing: the preview store kept its own "current" item, still
    // the screenshot, and an effect re-focused it on the very next render.
    browserResourceActions.adopt(
      scope,
      "agent-browser" as BrowserResourceId,
      "http://localhost:3000"
    );
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Browser/ }));
    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toBe(
        "browser:agent-browser"
      );
    });

    act(() => {
      openPreviewTab(scope, {
        type: "image",
        location: "/tmp/screenshot-1.jpg",
        title: "screenshot-1.jpg",
      });
    });
    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toContain(
        "screenshot-1.jpg"
      );
    });

    const [browserTab] = screen.getAllByRole("tab");
    fireEvent.click(browserTab!);

    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toBe(
        "browser:agent-browser"
      );
    });
    // And it stays there once every effect has had its say.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(rightPanelStore.get().scopes[scope]?.activeId).toBe(
      "browser:agent-browser"
    );
  });

  it("shows the preview whose tab is active, and closes it with the tab", async () => {
    renderPanel();
    act(() => {
      openPreviewTab(scope, { type: "md", location: "/a.md", title: "a.md" });
      openPreviewTab(scope, { type: "md", location: "/b.md", title: "b.md" });
    });
    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toContain("b.md");
    });

    const [first] = screen.getAllByRole("tab");
    fireEvent.click(first!);
    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toContain("a.md");
    });

    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await waitFor(() => {
      expect(rightPanelStore.get().scopes[scope]?.activeId).toContain("b.md");
    });
    expect(
      previewStore.get().scopes[scope]?.items.map(({ title }) => title)
    ).toEqual(["b.md"]);
  });

  it("shows a URL the agent presented, with no browser open first", async () => {
    // The `present_deliverable` path: openUrlInPreview opens a URL with no
    // resourceId, so a browser resource is minted for it. The tab has to be a
    // browser tab (nothing renders `resourceType: "url"`) and point at a
    // real resource, or the pane opens blank.
    renderPanel();

    act(() => {
      openPreviewTab(scope, {
        type: "url",
        location: "http://localhost:5173",
        title: "http://localhost:5173",
      });
    });

    await waitFor(() => {
      const panel = rightPanelStore.get().scopes[scope];
      const active = panel?.descriptors.find(({ id }) => id === panel.activeId);
      expect(active).toMatchObject({ resourceType: "browser" });
    });

    // And it points at a real resource carrying the URL, not a dangling key.
    const panel = rightPanelStore.get().scopes[scope];
    const active = panel?.descriptors.find(({ id }) => id === panel.activeId);
    const resources = selectBrowserResourceScope(
      browserResourceStore.get(),
      scope
    );
    const key =
      active != null && active.kind === "resource" ? active.resourceKey : "";

    expect(resources.resources[key]?.url).toBe("http://localhost:5173");
  });

  it("shows only the conversation's own previews, so switching chats swaps rather than leaks", async () => {
    // The pane belongs to whichever chat the shell says is on screen. A file
    // presented in another chat must not become a tab here. The old global
    // store mirrored every chat's items into the active scope on each switch.
    const otherScope = rightPanelScopeKey({
      workspaceId: "workspace-one",
      sessionId: "session-two",
    });
    act(() => {
      openPreviewTab(scope, {
        type: "md",
        location: "/tmp/from-session-one.md",
        title: "from-session-one.md",
      });
    });
    const hasTheFile = (key: string): boolean =>
      (rightPanelStore.get().scopes[key]?.descriptors ?? []).some(({ id }) =>
        id.includes("from-session-one.md")
      );
    renderPanel();
    await waitFor(() => {
      expect(hasTheFile(scope)).toBe(true);
    });

    act(() => {
      setActiveConversationKey(otherScope);
    });

    await waitFor(() => {
      expect(screen.getByTestId("preview-panel")).toBeTruthy();
    });
    expect(hasTheFile(otherScope)).toBe(false);
    expect(rightPanelStore.get().scopes[otherScope]?.descriptors ?? []).toEqual(
      []
    );
    // And the first chat's tab is still there for when it comes back.
    expect(hasTheFile(scope)).toBe(true);
  });

  it("shows each chat its own deliverable: a PDF in one, only the deck in the next", async () => {
    // What `present_deliverable` does, per conversation: the pane is tied to
    // the chat. A deck presented in the next chat must not sit beside (or
    // behind) the PDF the previous chat produced.
    const nextChat = rightPanelScopeKey({
      workspaceId: "workspace-one",
      sessionId: "session-two",
    });
    renderPanel();
    act(() => {
      openPreviewTab(scope, {
        type: "pdf",
        location: "/out/report.pdf",
        title: "report.pdf",
        fileAbsPath: "/out/report.pdf",
      });
    });
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /report\.pdf/ })).toBeTruthy();
    });

    act(() => {
      setActiveConversationKey(nextChat);
      openPreviewTab(nextChat, {
        type: "pptx",
        location: "/out/pitch.pptx",
        title: "pitch.pptx",
        fileAbsPath: "/out/pitch.pptx",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: /pitch\.pptx/ })).toBeTruthy();
    });
    expect(screen.queryByRole("tab", { name: /report\.pdf/ })).toBeNull();
    const next = rightPanelStore.get().scopes[nextChat];
    expect(next?.descriptors.map(({ id }) => id)).toHaveLength(1);
    expect(next?.activeId).toContain("pitch.pptx");
    expect(
      previewStore.get().scopes[nextChat]?.items.map(({ title }) => title)
    ).toEqual(["pitch.pptx"]);
    // The first chat keeps its PDF for when it comes back.
    expect(
      previewStore.get().scopes[scope]?.items.map(({ title }) => title)
    ).toEqual(["report.pdf"]);
    expect(rightPanelStore.get().scopes[scope]?.activeId).toContain(
      "report.pdf"
    );
  });

  it("keeps Files enabled and focuses the existing singleton", async () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Files/ }));
    openAddSurfaceMenu();
    const filesItem = await screen.findByRole("menuitem", { name: /Files/ });
    expect(filesItem.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(filesItem);
    openAddSurfaceMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: /Files/ }));

    await waitFor(() => {
      const state = rightPanelStore.get().scopes[scope];
      expect(
        state?.descriptors.filter(({ id }) => id === "files")
      ).toHaveLength(1);
      expect(state?.activeId).toBe("files");
    });
  });

  /** The pane it opened is gone, so the action that opened it must be too. */
  it("offers no Diff surface", async () => {
    renderPanel();

    openAddSurfaceMenu();

    expect(await screen.findByRole("menuitem", { name: /Files/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Diff/ })).toBeNull();
  });

  it("keeps terminal external and explains unavailable Agents and Device actions", () => {
    const props = renderPanel();

    const agents = screen.getByRole("button", { name: /Agents/ });
    const device = screen.getByRole("button", { name: /Device/ });
    expect((agents as HTMLButtonElement).disabled).toBe(true);
    expect(agents.getAttribute("title")).toBe(
      "No subagents in this conversation."
    );
    expect((device as HTMLButtonElement).disabled).toBe(true);
    expect(device.getAttribute("title")).toBe(
      "No device or simulator is available."
    );

    fireEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    expect(props.onOpenTerminal).toHaveBeenCalledOnce();
    expect(rightPanelStore.get().scopes[scope]?.descriptors ?? []).toHaveLength(
      0
    );
  });
});
