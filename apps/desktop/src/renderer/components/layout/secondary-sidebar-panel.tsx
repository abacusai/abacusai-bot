import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  Bot,
  FileCode2,
  FolderOpen,
  Globe,
  PanelRight,
  Plus,
  Smartphone,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  Activity,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type JSX,
} from "react";
import { useTranslation } from "react-i18next";

import { useSubtasks } from "../../conversation";
import { revealAgentBrowser } from "../../lib/agent-browser";
import { getBrowserHomepage } from "../../lib/browser-homepage";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { TITLEBAR_END_INSET } from "../../lib/window-chrome";
import { useWorkspaceActiveWorkspaceId } from "../../providers/workspace-state-provider";
import { useActiveConversationKey } from "../../stores/active-conversation-store";
import {
  browserResourceActions,
  useBrowserResources,
  type BrowserResourceId,
} from "../../stores/browser-resource-store";
import type { RightTabId } from "../../stores/code-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { previewActions } from "../../stores/preview-store";
import {
  rightPanelActions,
  useRightPanelScope,
} from "../../stores/right-panel-react";
import {
  createResourceRightPanelDescriptor,
  createSingletonRightPanelDescriptor,
  rightPanelScopeKey,
  type RightPanelDescriptor,
} from "../../stores/right-panel-store";
import { BrowserRuntimeSurface } from "../browser/browser-runtime-surface";
import { PreviewPanel } from "../browser/preview-panel";
import { AgentsPanel } from "../chat/agents-panel";
import { DevicePanel } from "../device/device-panel";
import { Button } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Sidebar, SidebarContent, SidebarHeader } from "../ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ExplorerPanel } from "../workspace/explorer-panel";

type SurfaceActionId = "agents" | "browser" | "device" | "files" | "terminal";

type SurfaceAction = {
  id: SurfaceActionId;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
};

const descriptorLegacyTab = (descriptor: RightPanelDescriptor): RightTabId => {
  if (descriptor.kind === "files") return "explorer";
  if (descriptor.kind !== "resource") return "preview";
  if (descriptor.resourceType === "agents") return "agents";
  if (
    descriptor.resourceType === "device" ||
    descriptor.resourceType === "simulator"
  )
    return "device";
  return "preview";
};

const DescriptorIcon = ({
  descriptor,
}: {
  descriptor: RightPanelDescriptor;
}): JSX.Element => {
  if (descriptor.kind === "files") return <FolderOpen className="size-3.5" />;
  if (descriptor.kind !== "resource") return <FileCode2 className="size-3.5" />;
  switch (descriptor.resourceType) {
    case "agents":
      return <Bot className="size-3.5" />;
    case "browser":
    case "url":
      return <Globe className="size-3.5" />;
    case "device":
    case "simulator":
      return <Smartphone className="size-3.5" />;
    default:
      return <FileCode2 className="size-3.5" />;
  }
};

const SurfaceIcon = ({
  id,
  className,
}: {
  id: SurfaceActionId;
  className?: string;
}): JSX.Element => {
  if (id === "browser") return <AppWindow className={className} />;
  if (id === "terminal") return <SquareTerminal className={className} />;
  if (id === "files") return <FolderOpen className={className} />;
  if (id === "agents") return <Bot className={className} />;
  return <Smartphone className={className} />;
};

const PeerTab = ({
  active,
  descriptor,
  closeLabel,
  onActivate,
  onClose,
}: {
  active: boolean;
  descriptor: RightPanelDescriptor;
  closeLabel: string;
  onActivate: () => void;
  onClose: () => void;
}): JSX.Element => {
  return (
    <div
      className={[
        "group/tab relative flex h-6 max-w-40 min-w-0 shrink-0 items-center overflow-hidden rounded-md",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      ].join(" ")}
      onAuxClick={(event) => {
        if (event.button === 1) onClose();
      }}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        role="tab"
        aria-selected={active}
        className="h-6 w-full max-w-full min-w-0 justify-start gap-1.5 overflow-hidden px-2 text-xs"
        onClick={onActivate}
      >
        <span className="flex size-4 shrink-0 items-center justify-center group-focus-within/tab:opacity-0 group-hover/tab:opacity-0">
          <DescriptorIcon descriptor={descriptor} />
        </span>
        <span className="truncate @max-[24rem]/right-header:hidden">
          {descriptor.title}
        </span>
      </Button>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute start-1 size-4 rounded-sm opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
              aria-label={closeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <X />
            </Button>
          }
        />
        <TooltipContent side="bottom">{closeLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
};

export const SecondarySidebarPanel = ({
  activeTab,
  onTabChange,
  onClose,
  onOpenTerminal,
  hideDevelopmentActions = false,
}: {
  /** Temporary route/Zustand compatibility input; descriptor state owns rendering. */
  activeTab: RightTabId | null;
  /** Temporary route/Zustand compatibility output; remove with the legacy bridge. */
  onTabChange: (tab: RightTabId) => void;
  onClose: () => void;
  onOpenTerminal: () => void;
  hideDevelopmentActions?: boolean;
}): JSX.Element => {
  const { t } = useTranslation();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const activeSessionId = useWorkspaceStore((state) =>
    activeWorkspaceId == null
      ? null
      : (state.workspaceUiStates[activeWorkspaceId]?.activeSessionId ?? null)
  );
  // The shell publishes the conversation on screen (it alone knows about the
  // bots pane's draft folder); the local computation is the fallback for the
  // first render before it has.
  const publishedScope = useActiveConversationKey();
  const scope = useMemo(
    () =>
      publishedScope ??
      rightPanelScopeKey({
        workspaceId: activeWorkspaceId ?? "__no-workspace__",
        sessionId: activeSessionId,
      }),
    [activeSessionId, activeWorkspaceId, publishedScope]
  );
  const panel = useRightPanelScope(scope);
  const browsers = useBrowserResources(scope);
  const subtasks = useSubtasks();
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const deviceStatusQuery = useQuery({
    queryKey: workspaceQueryKeys.deviceStatus,
    queryFn: async () => (await window.api?.agent?.getDeviceStatus?.()) ?? null,
    staleTime: 60_000,
  });
  const deviceEnabled = deviceStatusQuery.data?.enabled === true;
  const agentsReason = t("workspace.agents.emptyHint");

  const filesDescriptor = useMemo(
    () =>
      createSingletonRightPanelDescriptor(
        "files",
        t("workspace.rightPanel.files", { defaultValue: "Files" })
      ),
    [t]
  );
  const agentsSurfaceDescriptor = useMemo(
    () =>
      createResourceRightPanelDescriptor({
        id: "agents",
        resourceType: "agents",
        resourceKey: activeSessionId ?? "no-session",
        title: t("workspace.rightTab.agents"),
      }),
    [activeSessionId, t]
  );
  const deviceSurfaceDescriptor = useMemo(
    () =>
      createResourceRightPanelDescriptor({
        id: "device",
        resourceType: "device",
        resourceKey: activeWorkspaceId ?? "no-workspace",
        title: t("workspace.rightTab.device"),
      }),
    [activeWorkspaceId, t]
  );

  const focusDescriptor = (descriptor: RightPanelDescriptor): void => {
    rightPanelActions.focus(scope, descriptor);
  };

  const openBrowser = (): void => {
    // The browser the agent is already on, before a blank homepage.
    if (revealAgentBrowser(scope, "if-no-tab")) return;
    const resourceId = browserResourceActions.create(scope, {
      url: getBrowserHomepage(),
    });
    const descriptorId = `browser:${resourceId}`;
    focusDescriptor(
      createResourceRightPanelDescriptor({
        id: descriptorId,
        resourceType: "browser",
        resourceKey: resourceId,
        title: t("workspace.rightPanel.browser"),
      })
    );
  };

  const activateDescriptor = (descriptor: RightPanelDescriptor): void => {
    rightPanelActions.focusExisting(scope, descriptor.id);
  };

  const closeDescriptor = (descriptor: RightPanelDescriptor): void => {
    // The item behind a preview tab; a no-op for every other kind.
    previewActions.close(scope, descriptor.id);
    if (
      descriptor.kind === "resource" &&
      descriptor.resourceType === "browser"
    ) {
      const browser = browsers.find(({ id }) => id === descriptor.resourceKey);
      if (browser != null) {
        void window.api.agent
          .materializeBrowserRuntime({
            conversationKey: scope,
            resourceId: browser.id,
            ...(browser.profileId == null
              ? {}
              : { profileId: browser.profileId }),
          })
          .then(({ lease }) => window.api.agent.closeBrowserRuntime(lease));
      }
      browserResourceActions.dispose(
        scope,
        descriptor.resourceKey as BrowserResourceId
      );
    }
    rightPanelActions.close(scope, descriptor.id);
  };

  const allSurfaceActions: SurfaceAction[] = [
    {
      id: "browser",
      label: t("workspace.rightPanel.browser"),
      description: t("workspace.rightPanel.browserDescription"),
    },
    {
      id: "terminal",
      label: t("workspace.rightPanel.terminal", { defaultValue: "Terminal" }),
      description: t("workspace.rightPanel.terminalDescription", {
        defaultValue: "Start a shell in this workspace.",
      }),
      disabled: activeWorkspaceId == null,
      disabledReason:
        activeWorkspaceId == null
          ? t("workspace.terminalRequiresWorkspace")
          : undefined,
    },
    {
      id: "files",
      label: t("workspace.rightPanel.files", { defaultValue: "Files" }),
      description: t("workspace.rightPanel.explorerDescription"),
    },
    {
      id: "agents",
      label: t("workspace.rightTab.agents"),
      description: t("workspace.rightPanel.agentsDescription"),
      disabled: subtasks.length === 0,
      disabledReason: agentsReason,
    },
    {
      id: "device",
      label: t("workspace.rightTab.device"),
      description: t("workspace.rightPanel.deviceDescription"),
      disabled: !deviceEnabled,
      disabledReason: !deviceEnabled
        ? t("workspace.rightPanel.deviceUnavailable", {
            defaultValue: "No device or simulator is available.",
          })
        : undefined,
    },
  ];
  const surfaceActions = allSurfaceActions.filter(
    (action) => !hideDevelopmentActions || action.id !== "terminal"
  );

  const runSurfaceAction = (id: SurfaceActionId): void => {
    if (id === "browser") openBrowser();
    else if (id === "terminal") onOpenTerminal();
    else if (id === "files") focusDescriptor(filesDescriptor);
    else if (id === "agents") focusDescriptor(agentsSurfaceDescriptor);
    else focusDescriptor(deviceSurfaceDescriptor);
  };

  useEffect(() => {
    rightPanelActions.setAgentsAvailability(scope, {
      available: subtasks.length > 0,
      reason: subtasks.length > 0 ? null : agentsReason,
    });
  }, [agentsReason, scope, subtasks.length]);

  // LEGACY ROUTE BRIDGE: route search and CodeStore still speak RightTabId.
  useEffect(() => {
    if (activeTab === "explorer")
      rightPanelActions.focus(scope, filesDescriptor);
    else if (activeTab === "agents" && subtasks.length > 0)
      rightPanelActions.focus(scope, agentsSurfaceDescriptor);
    else if (activeTab === "device" && deviceEnabled)
      rightPanelActions.focus(scope, deviceSurfaceDescriptor);
  }, [
    activeTab,
    agentsSurfaceDescriptor,
    deviceEnabled,
    deviceSurfaceDescriptor,
    filesDescriptor,
    scope,
    subtasks.length,
  ]);

  const activeDescriptor =
    panel.descriptors.find(({ id }) => id === panel.activeId) ?? null;

  useEffect(() => {
    if (activeDescriptor != null) {
      onTabChange(descriptorLegacyTab(activeDescriptor));
    }
  }, [activeDescriptor, onTabChange]);

  useEffect(() => {
    const activeElement = tabStripRef.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]'
    );
    activeElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [panel.activeId]);

  const browserRuntime =
    activeDescriptor?.kind === "resource" &&
    activeDescriptor.resourceType === "browser"
      ? (browsers.find(({ id }) => id === activeDescriptor.resourceKey) ?? null)
      : null;
  const activeResourceType =
    activeDescriptor?.kind === "resource"
      ? activeDescriptor.resourceType
      : null;

  return (
    <Sidebar
      side="right"
      collapsible="none"
      className="bg-background h-full w-full min-w-0"
      data-id="secondary-sidebar-panel"
    >
      <SidebarHeader
        className="border-border h-(--workspace-topbar-height) min-h-(--workspace-topbar-height) shrink-0 flex-row items-center gap-1 border-b p-0 ps-2"
        style={
          {
            paddingRight: TITLEBAR_END_INSET,
            WebkitAppRegion: "drag",
          } as CSSProperties
        }
      >
        <div
          ref={tabStripRef}
          role="tablist"
          aria-label={t("workspace.rightPanel.tabs")}
          className="scroll-fade-x @container/right-header flex min-w-0 flex-1 [scrollbar-width:none] flex-nowrap items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:h-0"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          {panel.descriptors.map((descriptor) => {
            const browser =
              descriptor.kind === "resource" &&
              descriptor.resourceType === "browser"
                ? browsers.find(({ id }) => id === descriptor.resourceKey)
                : null;
            const renderedDescriptor =
              browser == null
                ? descriptor
                : { ...descriptor, title: browser.title };
            return (
              <PeerTab
                key={descriptor.id}
                active={panel.activeId === descriptor.id}
                descriptor={renderedDescriptor}
                closeLabel={t("workspace.preview.closeSurface", {
                  title: renderedDescriptor.title,
                })}
                onActivate={() => activateDescriptor(descriptor)}
                onClose={() => closeDescriptor(descriptor)}
              />
            );
          })}
        </div>
        <div
          className="flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0"
                        aria-label={t("workspace.preview.addSurface")}
                      />
                    }
                  >
                    <Plus />
                  </DropdownMenuTrigger>
                }
              />
              <TooltipContent side="bottom">
                {t("workspace.preview.addSurface")}
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">
              {surfaceActions.map((action) => {
                const open =
                  action.id === "files" &&
                  panel.descriptors.some(({ id }) => id === "files");
                return (
                  <DropdownMenuItem
                    key={action.id}
                    disabled={action.disabled}
                    title={action.disabledReason}
                    onClick={() => runSurfaceAction(action.id)}
                  >
                    <SurfaceIcon id={action.id} />
                    {action.label}
                    {open && (
                      <span className="text-muted-foreground ms-auto text-xs">
                        {t("workspace.rightPanel.open")}
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  data-id="local-code-right-sidebar-toggle"
                  aria-label={t("workspace.hideRightPanel")}
                  aria-pressed="true"
                  onClick={() => {
                    rightPanelActions.hide(scope);
                    onClose();
                  }}
                >
                  <PanelRight className="rtl:rotate-180" />
                </Button>
              }
            />
            <TooltipContent side="bottom">
              {t("workspace.hideRightPanel")}
            </TooltipContent>
          </Tooltip>
        </div>
      </SidebarHeader>
      <SidebarContent className="min-h-0 min-w-0 gap-0 overflow-hidden">
        {activeDescriptor == null && (
          <div className="@container flex h-full min-h-0 items-center justify-center overflow-y-auto p-4">
            <div className="my-auto w-full max-w-lg">
              <div className="mb-5 text-center">
                <p className="text-foreground text-sm font-medium">
                  {t("workspace.rightPanel.emptyTitle")}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t("workspace.rightPanel.emptyDescription")}
                </p>
              </div>
              <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
                {surfaceActions.map((action) => {
                  return (
                    <Button
                      key={action.id}
                      variant="outline"
                      className="h-auto min-h-20 w-full min-w-0 items-start justify-start gap-3 overflow-hidden p-3 text-start whitespace-normal"
                      disabled={action.disabled}
                      title={action.disabledReason}
                      onClick={() => runSurfaceAction(action.id)}
                    >
                      <SurfaceIcon id={action.id} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 overflow-hidden">
                        <span className="block text-sm font-medium break-words">
                          {action.label}
                        </span>
                        <span className="text-muted-foreground mt-1 block text-xs font-normal break-words">
                          {action.disabledReason ?? action.description}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <Activity
          mode={activeDescriptor?.kind === "files" ? "visible" : "hidden"}
        >
          <ExplorerPanel />
        </Activity>
        <Activity mode={activeResourceType === "agents" ? "visible" : "hidden"}>
          <AgentsPanel />
        </Activity>
        {activeResourceType === "browser" && browserRuntime != null && (
          <BrowserRuntimeSurface
            key={`${scope}:${browserRuntime.id}`}
            scope={scope}
            resource={browserRuntime}
          />
        )}
        <Activity
          mode={
            activeResourceType != null &&
            !["agents", "browser", "device", "simulator"].includes(
              activeResourceType
            )
              ? "visible"
              : "hidden"
          }
        >
          <PreviewPanel
            key={scope}
            scope={scope}
            tabId={activeDescriptor?.id ?? null}
          />
        </Activity>
        {deviceEnabled &&
          (activeResourceType === "device" ||
            activeResourceType === "simulator") && <DevicePanel />}
      </SidebarContent>
    </Sidebar>
  );
};
