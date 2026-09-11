import { fireEvent, render } from "@testing-library/react";
import { useImperativeHandle, type ReactNode, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sessionConversationKey } from "#shared/conversation-scope";

import {
  terminalRuntimeActions,
  terminalRuntimeStore,
} from "../../stores/terminal-runtime-store";

const { collapseTerminalPanel } = vi.hoisted(() => ({
  collapseTerminalPanel: vi.fn(),
}));

type TestLayout = Record<string, number>;

const shellLayout: TestLayout = {
  primarySidebar: 20,
  mainArea: 50,
  rightPanel: 30,
};

const workspaceState = {
  activeRightTab: "files",
  activeMainView: "chat",
  isRightPanelVisible: true,
  isSidebarVisible: true,
  capabilitiesTab: "connectors",
  setSidebarVisible: vi.fn((visible: boolean) => {
    workspaceState.isSidebarVisible = visible;
  }),
  setRightPanelVisible: vi.fn((visible: boolean) => {
    workspaceState.isRightPanelVisible = visible;
  }),
  setActiveRightTab: vi.fn(),
  setActiveSessionId: vi.fn(),
  activateWorkspaceSession: vi.fn(),
  getActiveSessionId: vi.fn((): string | null => "session"),
  openCapabilities: vi.fn(),
  workspaceUiStates: {
    workspace: { activeSessionId: "session" as string | null },
  },
  hydrateActiveWorkspaceFromMetadata: vi.fn(),
};

const useWorkspaceStore = Object.assign(
  <Value,>(selector: (state: typeof workspaceState) => Value): Value =>
    selector(workspaceState),
  { getState: () => workspaceState }
);

// The shell renders outside a RouterProvider here; the title bar only asks the
// router which pane it is showing.
vi.mock("@tanstack/react-router", () => ({
  useMatches: () => undefined,
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../stores/code-store", () => ({ useWorkspaceStore }));
vi.mock("../../hooks/use-workspace-queries", () => ({
  useWorkspaceAgentSessionsQuery: () => ({ data: [] }),
  useWorkspaceMetadataQuery: () => ({
    data: {
      activeWorkspaceId: "workspace",
      workspaces: [{ id: "workspace", path: "/workspace" }],
    },
  }),
  // The bots pane runs in the bot folder; the shell only needs an id back.
  useBotWorkspaceIdQuery: () => ({ data: "bot-workspace" }),
  useSessionTurnStateQuery: () => ({ data: { isBusy: false } }),
}));
vi.mock("../../hooks/use-bots", () => ({
  useBotsQuery: () => ({ data: [] }),
  useBotSenderChatsQuery: () => ({ data: [] }),
}));
vi.mock("../../hooks/use-routines", () => ({
  useRoutinesQuery: () => ({ data: [] }),
  useRoutinesEventSync: () => {},
}));
vi.mock("../../providers/workspace-state-provider", () => ({
  useWorkspaceActiveWorkspaceId: () => "workspace",
  useWorkspaceMetadata: () => ({
    data: {
      activeWorkspaceId: "workspace",
      workspaces: [{ id: "workspace", path: "/workspace", label: "Workspace" }],
    },
  }),
  useWorkspaceWorkspaceActions: () => ({
    addLocalWorkspace: vi.fn(),
  }),
}));
vi.mock("../../conversation/store", () => ({
  WorkspaceConversationProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("../../providers/preview-link-context", () => ({
  PreviewLinkProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    groupRef,
    id,
    onLayoutChanged,
    orientation,
  }: {
    children: ReactNode;
    groupRef?: Ref<{
      getLayout: () => TestLayout;
      setLayout: (layout: TestLayout) => TestLayout;
    } | null>;
    id: string;
    onLayoutChanged?: (
      layout: TestLayout,
      meta: { isUserInteraction: boolean }
    ) => void;
    orientation: string;
  }) => {
    useImperativeHandle(
      groupRef,
      () => ({
        getLayout: () => ({ ...shellLayout }),
        setLayout: (layout) => {
          Object.assign(shellLayout, layout);
          onLayoutChanged?.({ ...shellLayout }, { isUserInteraction: false });
          return { ...shellLayout };
        },
      }),
      [onLayoutChanged]
    );
    return (
      <section data-resizable-group={id} data-orientation={orientation}>
        {children}
        <button
          type="button"
          data-simulate-layout={id}
          onClick={() =>
            onLayoutChanged?.(
              id === "local-code-main-vertical-v2"
                ? { content: 70, terminal: 30 }
                : { ...shellLayout },
              { isUserInteraction: false }
            )
          }
        />
      </section>
    );
  },
  ResizablePanel: ({
    children,
    groupResizeBehavior,
    id,
    panelRef,
  }: {
    children: ReactNode;
    groupResizeBehavior?: string;
    id: string;
    panelRef?: Ref<{
      collapse: () => void;
      expand: () => void;
      getSize: () => { asPercentage: number; inPixels: number };
      isCollapsed: () => boolean;
      resize: (size: number) => void;
    } | null>;
  }) => {
    useImperativeHandle(
      panelRef,
      () => ({
        collapse: id === "terminal" ? collapseTerminalPanel : vi.fn(),
        expand: vi.fn(),
        getSize: () => ({ asPercentage: 30, inPixels: 240 }),
        isCollapsed: () => false,
        resize: vi.fn(),
      }),
      [id]
    );
    return (
      <div
        data-resizable-panel={id}
        data-group-resize-behavior={groupResizeBehavior}
      >
        {children}
      </div>
    );
  },
  ResizableHandle: () => <div data-resizable-handle="" />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));

const Container = ({ children }: { children: ReactNode }) => (
  <div>{children}</div>
);

vi.mock("../ui/sidebar", () => ({
  SidebarProvider: Container,
  SidebarInset: Container,
  Sidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SidebarContent: Container,
  SidebarFooter: Container,
  SidebarGroup: Container,
  SidebarGroupAction: (
    props: React.ButtonHTMLAttributes<HTMLButtonElement>
  ) => <button type="button" {...props} />,
  SidebarGroupLabel: ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  ),
  SidebarGroupContent: Container,
  SidebarHeader: Container,
  SidebarMenu: Container,
  SidebarMenuItem: Container,
  SidebarMenuButton: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SidebarTrigger: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props} />
  ),
  useSidebar: () => ({
    isMobile: false,
    open: workspaceState.isSidebarVisible,
    openMobile: false,
  }),
  SidebarRail: () => (
    <button type="button" data-sidebar="rail" aria-label="Resize sidebar" />
  ),
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <>{children}</> : null,
  SheetContent: Container,
  SheetDescription: Container,
  SheetTitle: Container,
}));

vi.mock("../brand/abacus-bot-logo", () => ({ AbacusBotLogo: () => null }));
vi.mock("../common/update-pill", () => ({ UpdatePill: () => null }));
vi.mock("../settings/settings-menu", () => ({ SettingsMenu: () => null }));
vi.mock("./deepagent-card", () => ({ DeepAgentCard: () => null }));
vi.mock("./credits-exhausted-card", () => ({
  CreditsExhaustedCard: () => null,
}));
vi.mock("../workspace/workspace-tree", () => ({
  CodeWorkspaceTree: () => <nav aria-label="Workspaces" />,
}));
vi.mock("../workspace/sessions-tree", () => ({
  SessionsTree: () => null,
}));

vi.mock("../bots/bots-tree", () => ({
  BotsTree: () => null,
}));

vi.mock("./secondary-sidebar-panel", () => ({
  SecondarySidebarPanel: ({ onClose }: { onClose: () => void }) => (
    <div data-surface="inspector">
      <button type="button" data-id="inspector-close" onClick={onClose}>
        Close inspector
      </button>
    </div>
  ),
}));
vi.mock("../chat/chat-panel", () => ({
  ChatPanel: () => <div data-surface="chat" />,
}));
vi.mock("../terminal/terminal-panel", () => ({
  TerminalPanel: () => <div data-terminal-owner="center" />,
}));

vi.mock("../workspace/artifacts-panel", () => ({
  ArtifactsPanel: () => null,
}));
vi.mock("../settings/models-panel", () => ({
  ApiKeysPanel: () => null,
}));
vi.mock("../settings/capabilities-panel", () => ({
  CapabilitiesPanel: () => null,
}));
vi.mock("../settings/memory-panel", () => ({
  MemoryPanel: () => null,
}));
vi.mock("../settings/usage-panel", () => ({ UsagePanel: () => null }));

const { WorkspaceView } = await import("./workspace-view");

const setCompactViewport = (matches: boolean): void => {
  window.matchMedia = vi.fn((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
};

const group = (id: string): HTMLElement =>
  document.querySelector(`[data-resizable-group="${id}"]`) as HTMLElement;

const panel = (id: string): HTMLElement =>
  document.querySelector(`[data-resizable-panel="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  terminalRuntimeActions.reset();
  Object.assign(shellLayout, {
    primarySidebar: 20,
    mainArea: 50,
    rightPanel: 30,
  });
  workspaceState.isSidebarVisible = true;
  workspaceState.isRightPanelVisible = true;
  setCompactViewport(false);
});

describe("workspace shell structure", () => {
  it("does not create a terminal when the persistent layout resizes", () => {
    render(<WorkspaceView />);

    expect(group("local-code-main-vertical-v2")).not.toBeNull();
    expect(panel("terminal")).not.toBeNull();
    expect(panel("terminal").dataset.groupResizeBehavior).toBe(
      "preserve-pixel-size"
    );

    collapseTerminalPanel.mockClear();
    fireEvent.click(
      document.querySelector(
        '[data-simulate-layout="local-code-main-vertical-v2"]'
      ) as HTMLElement
    );

    const scope = sessionConversationKey("workspace", "session");
    expect(terminalRuntimeStore.get().scopes[scope]).toBeUndefined();
    expect(collapseTerminalPanel).toHaveBeenCalledOnce();
    expect(group("local-code-main-vertical-v2")).not.toBeNull();
    expect(panel("terminal")).not.toBeNull();
  });

  it("removes the terminal toggle from bot routes", () => {
    workspaceState.getActiveSessionId.mockReturnValue(null);
    workspaceState.workspaceUiStates.workspace.activeSessionId = null;
    try {
      render(<WorkspaceView routeKind="bot" />);

      const toggle = document.querySelector(
        '[data-id="local-code-bottom-panel-toggle"]'
      );
      expect(toggle).toBeNull();
    } finally {
      workspaceState.getActiveSessionId.mockReturnValue("session");
      workspaceState.workspaceUiStates.workspace.activeSessionId = "session";
    }
  });

  it("opens the persistent terminal layout only after an explicit action", () => {
    render(<WorkspaceView />);

    fireEvent.click(
      document.querySelector(
        '[data-id="local-code-bottom-panel-toggle"]'
      ) as HTMLElement
    );

    const scope = sessionConversationKey("workspace", "session");
    expect(terminalRuntimeStore.get().scopes[scope]?.isOpen).toBe(true);
    expect(group("local-code-main-vertical-v2")).not.toBeNull();
    expect(panel("terminal")).not.toBeNull();
  });

  it("keeps the terminal in the center column and the inspector beside it at full height", () => {
    terminalRuntimeActions.setOpen(
      sessionConversationKey("workspace", "session"),
      true
    );
    render(<WorkspaceView />);

    const centerColumn = group("local-code-main-vertical-v2");
    const centerPanel = panel("mainArea");
    const terminalPanel = panel("terminal");
    const inspectorPanel = panel("rightPanel");

    expect.soft(centerColumn.contains(terminalPanel)).toBe(true);
    expect(
      terminalPanel.querySelector('[data-terminal-owner="center"]')
    ).not.toBeNull();
    expect.soft(centerPanel.contains(centerColumn)).toBe(true);
    expect.soft(centerColumn.contains(inspectorPanel)).toBe(false);
    expect
      .soft(inspectorPanel.parentElement)
      .toBe(group("local-code-shell-horizontal-v2"));
  });

  it("does not retain the desktop sidebar pane in compact layout", () => {
    setCompactViewport(true);
    render(<WorkspaceView />);

    expect(group("local-code-shell-horizontal-v1")).toBeNull();
    expect(panel("primarySidebar")).toBeNull();
  });

  it("does not render a clickable sidebar rail", () => {
    render(<WorkspaceView />);

    expect(document.querySelector('button[data-sidebar="rail"]')).toBeNull();
  });

  it("preserves the primary width when the right panel closes and reopens", () => {
    const view = render(<WorkspaceView />);

    fireEvent.click(
      document.querySelector('[data-id="inspector-close"]') as HTMLElement
    );
    expect(shellLayout).toEqual({
      primarySidebar: 20,
      mainArea: 80,
      rightPanel: 0,
    });

    view.rerender(<WorkspaceView />);
    const rightToggle = document.querySelector(
      '[data-id="local-code-right-sidebar-toggle"]'
    ) as HTMLButtonElement;
    expect(rightToggle).not.toBeNull();
    expect(rightToggle.getAttribute("aria-label")).toBe(
      "workspace.showRightPanel"
    );
    expect(rightToggle.querySelector(".lucide-panel-right")).not.toBeNull();

    fireEvent.click(rightToggle);
    expect(shellLayout).toEqual({
      primarySidebar: 20,
      mainArea: 50,
      rightPanel: 30,
    });
  });

  it("preserves the right width and PanelLeft semantics across sidebar toggles", () => {
    const view = render(<WorkspaceView />);
    let sidebarToggle = document.querySelector(
      '[data-id="local-code-sidebar-toggle"]'
    ) as HTMLButtonElement;

    expect(sidebarToggle.getAttribute("aria-label")).toBe(
      "workspace.hideSidebar"
    );
    expect(sidebarToggle.getAttribute("aria-pressed")).toBe("true");
    expect(sidebarToggle.querySelector(".lucide-panel-left")).not.toBeNull();

    fireEvent.click(sidebarToggle);
    expect(shellLayout).toEqual({
      primarySidebar: 0,
      mainArea: 70,
      rightPanel: 30,
    });

    view.rerender(<WorkspaceView />);
    sidebarToggle = document.querySelector(
      '[data-id="local-code-sidebar-toggle"]'
    ) as HTMLButtonElement;
    const newChat = document.querySelector(
      '[data-id="local-code-new-chat"]'
    ) as HTMLButtonElement;
    expect(sidebarToggle.getAttribute("aria-label")).toBe(
      "workspace.showSidebar"
    );
    expect(sidebarToggle.getAttribute("aria-pressed")).toBe("false");
    expect(sidebarToggle.querySelector(".lucide-panel-left")).not.toBeNull();
    expect(newChat.parentElement).toBe(sidebarToggle.parentElement);

    fireEvent.click(sidebarToggle);
    expect(shellLayout).toEqual({
      primarySidebar: 20,
      mainArea: 50,
      rightPanel: 30,
    });
  });
});
