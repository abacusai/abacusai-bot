import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  useDefaultLayout,
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";

import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
} from "#shared/conversation-scope";

import { WorkspaceConversationProvider } from "../../conversation/store";
import {
  useBotWorkspaceIdQuery,
  useWorkspaceMetadataQuery,
} from "../../hooks/use-workspace-queries";
import { revealAgentBrowser } from "../../lib/agent-browser";
import type { WorkspaceRouteKind } from "../../lib/workspace-route";
import { PreviewLinkProvider } from "../../providers/preview-link-context";
import { useWorkspaceActiveWorkspaceId } from "../../providers/workspace-state-provider";
import { setActiveConversationKey } from "../../stores/active-conversation-store";
import { useWorkspaceStore } from "../../stores/code-store";
import {
  rightPanelActions,
  useRightPanelScope,
} from "../../stores/right-panel-react";
import { rightPanelScopeKey } from "../../stores/right-panel-store";
import {
  terminalRuntimeActions,
  terminalRuntimeStore,
  useTerminalRuntimeScope,
} from "../../stores/terminal-runtime-store";
import {
  openUrlInPreview,
  openAbsoluteFileInPreview,
  containmentRootFor,
  isAbsoluteFilePath,
} from "../../utils/preview-utils";
import { ChatPanel } from "../chat/chat-panel";
import { TerminalPanel } from "../terminal/terminal-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui/resizable";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "../ui/sheet";
import { SidebarInset, SidebarProvider } from "../ui/sidebar";
import { SecondarySidebarPanel } from "./secondary-sidebar-panel";
import { SidebarControl, TitleBar } from "./titlebar";
import { WorkspaceSidebar } from "./workspace-sidebar";

export const secondarySidebarPanelPaddingClassName = "h-full overflow-auto p-2";

export const WorkspaceView = ({
  mainContent,
  routeKind = "session",
}: {
  /**
   * Replaces the chat panel in the centre column, keeping the sidebar, title
   * bar, terminal and inspector around it. This is what lets a capabilities
   * page open in the pane instead of taking the window over.
   */
  mainContent?: ReactNode;
  routeKind?: WorkspaceRouteKind;
} = {}): JSX.Element => {
  const { t } = useTranslation();
  const terminalAllowed = routeKind === "session";
  const inspectorAllowed = routeKind !== "settings";
  const hideDevelopmentActions = routeKind === "bot";
  const [isCompact, setIsCompact] = useState(
    () => window.matchMedia("(max-width: 959px)").matches
  );
  const [compactInspectorOpen, setCompactInspectorOpen] = useState(false);
  const activeRightTab = useWorkspaceStore((state) => state.activeRightTab);
  const setSidebarVisible = useWorkspaceStore(
    (state) => state.setSidebarVisible
  );
  const setRightPanelVisible = useWorkspaceStore(
    (state) => state.setRightPanelVisible
  );
  const setActiveRightTab = useWorkspaceStore(
    (state) => state.setActiveRightTab
  );
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const newPaneIntent = useWorkspaceStore((state) => state.newPaneIntent);
  const activeSessionId = useWorkspaceStore((state) =>
    activeWorkspaceId == null
      ? null
      : (state.workspaceUiStates[activeWorkspaceId]?.activeSessionId ?? null)
  );
  // The bots pane runs in the bot folder, so its terminal is scoped there; a
  // terminal sitting on it is how the user learns which folder that is.
  const showingBotsPane = newPaneIntent === "bot" && activeSessionId == null;
  const botWorkspaceQuery = useBotWorkspaceIdQuery(showingBotsPane);
  const botWorkspaceId = botWorkspaceQuery.data ?? null;

  const terminalConversation = showingBotsPane
    ? botWorkspaceId == null
      ? null
      : draftConversationRef(botWorkspaceId)
    : activeWorkspaceId == null
      ? null
      : activeSessionId == null
        ? draftConversationRef(activeWorkspaceId)
        : sessionConversationRef(activeWorkspaceId, activeSessionId);
  const terminalConversationKey =
    terminalConversation == null ? null : conversationKey(terminalConversation);
  // The bots pane's inspector is scoped to the bot folder for the same reason
  // its terminal is: that is the workspace the bot will run in.
  const rightPanelConversationKey =
    showingBotsPane && botWorkspaceId != null
      ? rightPanelScopeKey({ workspaceId: botWorkspaceId, sessionId: null })
      : activeWorkspaceId == null
        ? rightPanelScopeKey({
            workspaceId: "__no-workspace__",
            sessionId: null,
          })
        : rightPanelScopeKey({
            workspaceId: activeWorkspaceId,
            sessionId: activeSessionId,
          });
  // Published for everything that opens a pane without being rendered inside
  // one: click handlers and the agent's preview events read it from the store.
  useEffect(() => {
    setActiveConversationKey(rightPanelConversationKey);
    // A chat whose agent browsed while it was in the background surfaces
    // that browser the first time the chat comes on screen.
    revealAgentBrowser(rightPanelConversationKey, "first-time");
  }, [rightPanelConversationKey]);
  const rightPanelScope = useRightPanelScope(rightPanelConversationKey);
  const terminalScope = useTerminalRuntimeScope(terminalConversationKey);
  const isBottomPanelVisible = terminalAllowed && terminalScope.isOpen;
  const metadataQuery = useWorkspaceMetadataQuery();
  const workspaceRoot =
    metadataQuery.data?.workspaces?.find((w) => w.id === activeWorkspaceId)
      ?.path ?? null;
  const metadataActiveWorkspaceId =
    metadataQuery.data?.activeWorkspaceId ?? null;
  const metadataWorkspaces = metadataQuery.data?.workspaces;

  useEffect(() => {
    const media = window.matchMedia("(max-width: 959px)");
    const update = (): void => setIsCompact(media.matches);
    media.addEventListener("change", update);
    return (): void => media.removeEventListener("change", update);
  }, []);

  // The Zustand store owns activeWorkspaceId at runtime; this only fills it on
  // the first metadata read or recovers from a workspace deleted underneath it.
  useEffect(() => {
    if (metadataWorkspaces == null) return;
    const ids = metadataWorkspaces
      .map((w) => w.id)
      .filter((x): x is string => typeof x === "string");
    useWorkspaceStore
      .getState()
      .hydrateActiveWorkspaceFromMetadata(metadataActiveWorkspaceId, ids);
  }, [metadataActiveWorkspaceId, metadataWorkspaces]);

  const primaryPanelRef = useRef<PanelImperativeHandle>(null);
  const shellGroupRef = useRef<GroupImperativeHandle>(null);
  const rightPanelRef = useRef<PanelImperativeHandle>(null);
  const terminalPanelRef = useRef<PanelImperativeHandle>(null);
  const lastPrimaryPanelSizeRef = useRef(18);
  const lastRightPanelSizeRef = useRef(30);
  const lastTerminalPanelSizeRef = useRef(240);

  const shellLayoutState = useDefaultLayout({
    id: "local-code-shell-horizontal-v2",
    panelIds: ["primarySidebar", "mainArea", "rightPanel"],
    onlySaveAfterUserInteractions: true,
  });
  const terminalLayoutState = useDefaultLayout({
    id: "local-code-main-vertical-v2",
    panelIds: ["content", "terminal"],
    onlySaveAfterUserInteractions: true,
  });

  const handlePrimaryPanelResize = (size: PanelSize): void => {
    const isCollapsed = size.inPixels <= 0;
    const store = useWorkspaceStore.getState();
    if (store.isSidebarVisible === isCollapsed) {
      store.setSidebarVisible(!isCollapsed);
    }
  };

  const handleRightPanelResize = (size: PanelSize): void => {
    const isCollapsed = size.inPixels <= 0;
    const store = useWorkspaceStore.getState();
    if (store.isRightPanelVisible === isCollapsed) {
      store.setRightPanelVisible(!isCollapsed);
    }
    if (rightPanelScope.isOpen === isCollapsed) {
      if (isCollapsed) rightPanelActions.hide(rightPanelConversationKey);
      else rightPanelActions.show(rightPanelConversationKey);
    }
  };

  const setShellPanelVisible = useCallback(
    (panelId: "primarySidebar" | "rightPanel", visible: boolean): void => {
      const group = shellGroupRef.current;
      if (group == null) return;
      const layout = group.getLayout();
      const currentSize = layout[panelId] ?? 0;
      const centerSize = layout.mainArea ?? 100;

      if (!visible) {
        if (currentSize <= 0) return;
        if (panelId === "primarySidebar") {
          lastPrimaryPanelSizeRef.current = currentSize;
        } else {
          lastRightPanelSizeRef.current = currentSize;
        }
        group.setLayout({
          ...layout,
          [panelId]: 0,
          mainArea: centerSize + currentSize,
        });
        return;
      }

      if (currentSize > 0) return;
      const restoredSize =
        panelId === "primarySidebar"
          ? lastPrimaryPanelSizeRef.current
          : lastRightPanelSizeRef.current;
      group.setLayout({
        ...layout,
        [panelId]: restoredSize,
        mainArea: centerSize - restoredSize,
      });
    },
    []
  );

  const isRightPanelVisible = inspectorAllowed && rightPanelScope.isOpen;
  const isSidebarVisible = useWorkspaceStore((state) => state.isSidebarVisible);
  useEffect(() => {
    if (isCompact) return;
    const panel = primaryPanelRef.current;
    if (panel == null) return;
    setShellPanelVisible("primarySidebar", isSidebarVisible);
  }, [isCompact, isSidebarVisible, setShellPanelVisible]);

  useEffect(() => {
    if (isCompact) return;
    const panel = rightPanelRef.current;
    if (panel == null) return;
    setShellPanelVisible("rightPanel", isRightPanelVisible);
  }, [isCompact, isRightPanelVisible, setShellPanelVisible]);

  useEffect(() => {
    if (!isCompact) setCompactInspectorOpen(false);
  }, [isCompact]);

  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (panel == null) return;
    if (isBottomPanelVisible) {
      if (panel.getSize().inPixels < 160) {
        panel.resize(Math.max(160, lastTerminalPanelSizeRef.current));
      }
      return;
    }
    if (!panel.isCollapsed()) panel.collapse();
  }, [isBottomPanelVisible]);

  const togglePrimaryPanel = useCallback((): void => {
    setShellPanelVisible("primarySidebar", !isSidebarVisible);
    setSidebarVisible(!isSidebarVisible);
  }, [isSidebarVisible, setShellPanelVisible, setSidebarVisible]);

  const openRightPanel = useCallback((): void => {
    rightPanelActions.show(rightPanelConversationKey);
    if (isCompact) {
      setCompactInspectorOpen(true);
      return;
    }
    setRightPanelVisible(true);
    setShellPanelVisible("rightPanel", true);
  }, [
    isCompact,
    rightPanelConversationKey,
    setRightPanelVisible,
    setShellPanelVisible,
  ]);

  const closeRightPanel = useCallback((): void => {
    rightPanelActions.hide(rightPanelConversationKey);
    setActiveRightTab(null);
    if (isCompact) {
      setCompactInspectorOpen(false);
      return;
    }
    setShellPanelVisible("rightPanel", false);
    setRightPanelVisible(false);
  }, [
    isCompact,
    rightPanelConversationKey,
    setActiveRightTab,
    setRightPanelVisible,
    setShellPanelVisible,
  ]);

  const toggleRightPanel = useCallback((): void => {
    if (isCompact) {
      setCompactInspectorOpen((open) => !open);
      return;
    }
    if (isRightPanelVisible) closeRightPanel();
    else openRightPanel();
  }, [closeRightPanel, isCompact, isRightPanelVisible, openRightPanel]);

  const closeTerminalPanel = useCallback((): void => {
    if (terminalConversationKey != null) {
      terminalRuntimeActions.setOpen(terminalConversationKey, false);
    }
  }, [terminalConversationKey]);

  const toggleTerminalPanel = useCallback((): void => {
    if (isBottomPanelVisible) {
      closeTerminalPanel();
      return;
    }
    // The conversation key is the requirement, not an active workspace: the
    // bots pane's terminal is scoped to the bot folder, not to anything active.
    if (terminalConversationKey == null) return;
    terminalRuntimeActions.setOpen(terminalConversationKey, true);
  }, [closeTerminalPanel, isBottomPanelVisible, terminalConversationKey]);

  const handlePreviewLink = useCallback(
    (href: string) => {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        openUrlInPreview(href);
        openRightPanel();
      } else {
        // The read-file IPC needs a containment root, but the WORKSPACE root is
        // wrong for an absolute path outside it ('outside-root', silently opens
        // in Finder), so absolute paths use their own directory.

        const hostRoot = isAbsoluteFilePath(href)
          ? containmentRootFor(href, workspaceRoot)
          : (workspaceRoot ?? undefined);
        void openAbsoluteFileInPreview(href, hostRoot).then(() => {
          openRightPanel();
        });
      }
    },
    [openRightPanel, workspaceRoot]
  );

  const chatSurface = (
    <div className="bg-background flex h-full min-w-0 flex-col overflow-hidden">
      <TitleBar
        routeKind={routeKind}
        compact={isCompact}
        compactInspectorOpen={compactInspectorOpen}
        inspectorOpen={isRightPanelVisible}
        terminalOpen={isBottomPanelVisible}
        onToggleRightPanel={toggleRightPanel}
        onToggleTerminal={toggleTerminalPanel}
      />
      <div className="min-h-0 flex-1">{mainContent ?? <ChatPanel />}</div>
    </div>
  );

  const centerColumn = (
    <ResizablePanelGroup
      id="local-code-main-vertical-v2"
      orientation="vertical"
      className="h-full"
      defaultLayout={
        terminalLayoutState.defaultLayout ?? {
          content: 70,
          terminal: 30,
        }
      }
      onLayoutChanged={(layout, meta) => {
        const terminalSize = layout.terminal ?? 0;
        if (terminalSize > 0) {
          const panelSize = terminalPanelRef.current?.getSize().inPixels ?? 0;
          if (panelSize >= 160) lastTerminalPanelSizeRef.current = panelSize;
        }
        terminalLayoutState.onLayoutChanged(layout, meta);
        if (!meta.isUserInteraction) {
          const terminalIsOpen =
            terminalConversationKey != null &&
            terminalRuntimeStore.get().scopes[terminalConversationKey]
              ?.isOpen === true;
          if (terminalSize > 0 && !terminalIsOpen) {
            const panel = terminalPanelRef.current;
            if (panel != null && !panel.isCollapsed()) panel.collapse();
          }
          return;
        }
        if (terminalConversationKey == null) return;
        const isCollapsed = terminalSize <= 0;
        if (terminalScope.isOpen === isCollapsed) {
          terminalRuntimeActions.setOpen(terminalConversationKey, !isCollapsed);
        }
      }}
    >
      <ResizablePanel
        id="content"
        defaultSize="70%"
        minSize={300}
        className="min-h-0"
      >
        {chatSurface}
      </ResizablePanel>

      <ResizableHandle
        withHandle
        aria-label={t("workspace.resizeTerminal")}
        className={
          activeWorkspaceId == null || !terminalAllowed ? "hidden" : undefined
        }
        disabled={activeWorkspaceId == null || !terminalAllowed}
      />

      <ResizablePanel
        id="terminal"
        panelRef={terminalPanelRef}
        defaultSize="30%"
        minSize={160}
        maxSize={600}
        collapsible
        collapsedSize={0}
        groupResizeBehavior="preserve-pixel-size"
        className="bg-[#1e1e1e]"
      >
        <div className="h-full" data-id="terminal-panel">
          <TerminalPanel
            conversation={terminalConversation}
            conversationKey={terminalConversationKey}
            generation={terminalScope.generation}
            visible={isBottomPanelVisible}
            onClose={closeTerminalPanel}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );

  const workspaceInset = (
    <SidebarInset
      data-id="local-code-mode"
      className="bg-background text-foreground h-full min-h-0 min-w-0 overflow-hidden"
    >
      <main className="min-h-0 min-w-0 flex-1">{centerColumn}</main>

      {isCompact && inspectorAllowed && (
        <Sheet
          open={compactInspectorOpen}
          onOpenChange={setCompactInspectorOpen}
        >
          <SheetContent
            side="right"
            className="bg-card/95 w-96 max-w-[90vw] p-0 backdrop-blur-xl"
            data-id="compact-workspace-inspector"
            showCloseButton={false}
          >
            <SheetTitle className="sr-only">
              {t("workspace.inspectorTitle")}
            </SheetTitle>
            <SheetDescription className="sr-only">
              {t("workspace.inspectorDescription")}
            </SheetDescription>
            <SecondarySidebarPanel
              activeTab={activeRightTab}
              onTabChange={setActiveRightTab}
              onClose={closeRightPanel}
              onOpenTerminal={toggleTerminalPanel}
              hideDevelopmentActions={hideDevelopmentActions}
            />
          </SheetContent>
        </Sheet>
      )}
    </SidebarInset>
  );

  return (
    <PreviewLinkProvider onLinkClick={handlePreviewLink}>
      <WorkspaceConversationProvider
        sessionId={activeSessionId}
        workspaceId={activeWorkspaceId}
      >
        <SidebarProvider
          open={isSidebarVisible}
          onOpenChange={setSidebarVisible}
          className="absolute inset-0 min-h-0 overflow-hidden"
        >
          {isCompact ? (
            <>
              <WorkspaceSidebar />
              <SidebarControl compact onToggle={() => undefined} />
              {workspaceInset}
            </>
          ) : (
            <div className="relative h-full min-h-0 w-full min-w-0">
              <ResizablePanelGroup
                id="local-code-shell-horizontal-v2"
                orientation="horizontal"
                groupRef={shellGroupRef}
                defaultLayout={shellLayoutState.defaultLayout}
                onLayoutChanged={(layout, meta) => {
                  const primarySize = layout.primarySidebar ?? 0;
                  const rightSize = layout.rightPanel ?? 0;
                  if (primarySize > 0) {
                    lastPrimaryPanelSizeRef.current = primarySize;
                  }
                  if (rightSize > 0) {
                    lastRightPanelSizeRef.current = rightSize;
                  }
                  shellLayoutState.onLayoutChanged(layout, meta);
                }}
              >
                <ResizablePanel
                  id="primarySidebar"
                  panelRef={primaryPanelRef}
                  defaultSize={240}
                  minSize={240}
                  maxSize={420}
                  collapsible
                  collapsedSize={0}
                  groupResizeBehavior="preserve-pixel-size"
                  onResize={handlePrimaryPanelResize}
                >
                  <WorkspaceSidebar
                    static
                    visible={isSidebarVisible}
                    onToggle={togglePrimaryPanel}
                  />
                </ResizablePanel>

                <ResizableHandle
                  withHandle
                  aria-label={t("workspace.resizeSidebar")}
                />

                <ResizablePanel
                  id="mainArea"
                  defaultSize="100%"
                  minSize={320}
                  groupResizeBehavior="preserve-relative-size"
                  className="min-w-0"
                >
                  {workspaceInset}
                </ResizablePanel>

                <ResizableHandle
                  withHandle
                  aria-label={t("workspace.resizeInspector")}
                  className={!inspectorAllowed ? "hidden" : undefined}
                  disabled={!inspectorAllowed}
                />

                <ResizablePanel
                  id="rightPanel"
                  panelRef={rightPanelRef}
                  defaultSize={420}
                  minSize={280}
                  maxSize={960}
                  collapsible
                  collapsedSize={0}
                  groupResizeBehavior="preserve-pixel-size"
                  onResize={handleRightPanelResize}
                  className="bg-background"
                >
                  {inspectorAllowed && (
                    <SecondarySidebarPanel
                      activeTab={activeRightTab}
                      onTabChange={setActiveRightTab}
                      onClose={closeRightPanel}
                      onOpenTerminal={toggleTerminalPanel}
                      hideDevelopmentActions={hideDevelopmentActions}
                    />
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>

              <SidebarControl compact={false} onToggle={togglePrimaryPanel} />
            </div>
          )}
        </SidebarProvider>
      </WorkspaceConversationProvider>
    </PreviewLinkProvider>
  );
};
