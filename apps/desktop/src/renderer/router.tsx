import type { QueryClient } from "@tanstack/react-query";
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from "@tanstack/react-router";
import { useEffect, useRef, useState, type JSX } from "react";

import type { Bot } from "#shared/bots";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";
import { TOOLSETS_BY_ID } from "#shared/toolsets";

import App from "./app";
import { BotDialog } from "./components/bots/bot-dialog";
import { BrowserSettingsPanel } from "./components/browser/browser-settings-dialog";
import { ChatPanel } from "./components/chat/chat-panel";
import { DeviceSettingsPanel } from "./components/device/device-settings-dialog";
import { FocusedPage, FocusedPageBody } from "./components/layout/focused-page";
import {
  CapabilitiesPane,
  PlainPane,
} from "./components/layout/in-pane-settings";
import { WorkspaceView } from "./components/layout/workspace-view";
import { McpManagementPanel } from "./components/mcp/mcp-management-panel";
import { RoutinePage } from "./components/routines/routine-page";
import {
  ToolsPanel,
  ToolsetPanel,
} from "./components/settings/capabilities-panel";
import { ChangelogPanel } from "./components/settings/changelog-panel";
import { ConnectorsPanel } from "./components/settings/connectors-panel";
import { MemoryPanel } from "./components/settings/memory-panel";
import { ModelsSettingsPanel } from "./components/settings/models-panel";
import { NotificationSettingsPanel } from "./components/settings/notification-settings-dialog";
import { ProfilePanel } from "./components/settings/profile-panel";
import { RoutinesPanel } from "./components/settings/routines-panel";
import { UsagePanel } from "./components/settings/usage-panel";
import { SkillsManagementPanel } from "./components/skills/skills-management-panel";
import { Spinner } from "./components/ui";
import { ArtifactsPanel } from "./components/workspace/artifacts-panel";
import { useBotsQuery, useOpenBotChatMutation } from "./hooks/use-bots";
import {
  allAgentSessionsQueryOptions,
  sessionArtifactsQueryOptions,
  useAllAgentSessionsQuery,
  useWorkspaceMetadataQuery,
  workspaceMetadataQueryOptions,
} from "./hooks/use-workspace-queries";
import { parseWorkspaceSearch } from "./lib/route-search";
import { useWorkspaceRouteKind } from "./lib/workspace-route";
import { isAppInternalWorkspace } from "./lib/workspace-utils";
import { useWorkspaceStore } from "./stores/code-store";

type RouterContext = { queryClient: QueryClient };

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: App,
  notFoundComponent: () => <Outlet />,
});

/** One mounted shell for every page that belongs beside the conversation lists. */
const workspaceShellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "_workspaceShell",
  component: WorkspaceShell,
});

function WorkspaceShell(): JSX.Element {
  const routeKind = useWorkspaceRouteKind();
  return <WorkspaceView routeKind={routeKind} mainContent={<Outlet />} />;
}

const codingLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_coding",
  component: Outlet,
  staticData: { workspaceKind: "session" },
});

const workspaceRoute = createRoute({
  getParentRoute: () => codingLayoutRoute,
  path: "/",
  validateSearch: parseWorkspaceSearch,
  beforeLoad: ({ search }) => {
    if (search.view === "capabilities") {
      const destination =
        search.capabilities === "connectors"
          ? "/settings/connectors"
          : search.capabilities === "skills"
            ? "/settings/skills"
            : search.capabilities === "mcp"
              ? "/settings/mcp"
              : "/settings/tools";
      throw redirect({ to: destination, replace: true });
    }
    // Messaging platforms live under connectors.
    if (search.view === "messaging")
      throw redirect({ to: "/settings/connectors", replace: true });
    if (search.view === "artifacts")
      throw redirect({ to: "/settings/artifacts", replace: true });
    if (search.view === "memory")
      throw redirect({ to: "/settings/memory", replace: true });
    if (search.view === "usage")
      throw redirect({ to: "/settings/usage", replace: true });
  },
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(workspaceMetadataQueryOptions()),
  component: WorkspaceRoute,
});

function WorkspaceRoute(): JSX.Element {
  const search = workspaceRoute.useSearch();
  const navigate = workspaceRoute.useNavigate();
  const activeRightTab = useWorkspaceStore((state) => state.activeRightTab);
  const appliedSearchKey = useRef<string | null>(null);
  const searchDrivenUpdate = useRef(false);
  const searchKey = JSON.stringify(search);

  useEffect(() => {
    if (appliedSearchKey.current === searchKey) return;
    appliedSearchKey.current = searchKey;
    searchDrivenUpdate.current = true;
    const store = useWorkspaceStore.getState();
    const routePanel = search.panel ?? null;
    if (store.activeRightTab !== routePanel) {
      store.setActiveRightTab(routePanel);
    }
  }, [search, searchKey]);

  useEffect(() => {
    if (searchDrivenUpdate.current) {
      searchDrivenUpdate.current = false;
      return;
    }
    if (search.panel === activeRightTab) return;
    appliedSearchKey.current = JSON.stringify({
      view: "chat",
      ...(activeRightTab == null ? {} : { panel: activeRightTab }),
      capabilities: "connectors",
    });
    void navigate({
      replace: true,
      search: {
        view: "chat",
        ...(activeRightTab == null ? {} : { panel: activeRightTab }),
        capabilities: "connectors",
      },
    });
  }, [activeRightTab, navigate, search]);

  return <ChatPanel />;
}

const sessionsLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_sessions",
  component: Outlet,
  staticData: { workspaceKind: "session" },
});

const newSessionRoute = createRoute({
  getParentRoute: () => sessionsLayoutRoute,
  path: "/sessions/new",
  component: NewSessionRoute,
});

function NewSessionRoute(): JSX.Element {
  const workspaces = useWorkspaceMetadataQuery().data?.workspaces;
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  useEffect(() => {
    const store = useWorkspaceStore.getState();
    store.setNewPaneIntent("session");
    store.deselectWorkspace();
  }, []);
  // A new session opens on the last-used workspace once the list says it still
  // exists. Keyed on the active workspace too: the sidebar's + clears it after
  // navigating, and that clear is all that changes.
  useEffect(() => {
    if (workspaces == null || activeWorkspaceId != null) return;
    const store = useWorkspaceStore.getState();
    const last = workspaces.find(
      (workspace) =>
        workspace.id === store.lastPickedWorkspaceId &&
        workspace.status !== "deleted" &&
        !isAppInternalWorkspace(workspace)
    );
    if (last == null) return;
    store.activateWorkspaceSession(last.id, null);
    void window.api.agent.switchWorkspace(last.id);
  }, [workspaces, activeWorkspaceId]);
  return <ChatPanel />;
}

const sessionRoute = createRoute({
  getParentRoute: () => sessionsLayoutRoute,
  path: "/sessions/$sessionId",
  component: SessionRoute,
});

function activateSession(workspaceId: string, sessionId: string): void {
  const store = useWorkspaceStore.getState();
  const previousWorkspaceId = store.activeWorkspaceId;
  store.activateWorkspaceSession(workspaceId, sessionId);
  store.markSessionViewed(sessionId);
  if (previousWorkspaceId !== workspaceId) {
    void window.api.agent.switchWorkspace(workspaceId);
  }
}

function SessionRoute(): JSX.Element {
  const { sessionId } = sessionRoute.useParams();
  const sessionsQuery = useAllAgentSessionsQuery();
  const session = sessionsQuery.data?.find((entry) => entry.id === sessionId);

  useEffect(() => {
    if (session != null) activateSession(session.workspaceId, session.id);
  }, [session]);

  if (session == null && sessionsQuery.isPending) return <RouteLoading />;
  return <ChatPanel />;
}

const botsLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_bots",
  component: Outlet,
  staticData: { workspaceKind: "bot" },
});

const routinesLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_routines",
  component: Outlet,
  staticData: { workspaceKind: "session" },
});

const routineRoute = createRoute({
  getParentRoute: () => routinesLayoutRoute,
  path: "/routines/$routineId",
  component: RoutinePageRoute,
});

function RoutinePageRoute(): JSX.Element {
  const { routineId } = routineRoute.useParams();
  return <RoutinePage routineId={routineId} />;
}

const newBotRoute = createRoute({
  getParentRoute: () => botsLayoutRoute,
  path: "/bots/new",
  component: NewBotRoute,
});

function NewBotRoute(): JSX.Element {
  useEffect(() => {
    const store = useWorkspaceStore.getState();
    store.setNewPaneIntent("bot");
    const workspaceId = store.activeWorkspaceId;
    if (workspaceId != null) store.setActiveSessionId(workspaceId, null);
  }, []);
  return <ChatPanel />;
}

const botRoute = createRoute({
  getParentRoute: () => botsLayoutRoute,
  path: "/bots/$botId",
  component: BotChatRoute,
});

const editBotRoute = createRoute({
  getParentRoute: () => botsLayoutRoute,
  path: "/bots/$botId/edit",
  component: EditBotRoute,
});

function useOpenRoutedBot(botId: string): {
  bot: Bot | null;
  pending: boolean;
} {
  const botsQuery = useBotsQuery();
  const openBot = useOpenBotChatMutation();
  const bot = botsQuery.data?.find((entry) => entry.id === botId) ?? null;
  const openedBotId = useRef<string | null>(null);

  useEffect(() => {
    if (bot == null || openedBotId.current === bot.id) return;
    openedBotId.current = bot.id;
    void openBot
      .mutateAsync(bot.id)
      .then((handle) => {
        activateSession(handle.workspaceId, handle.sessionId);
      })
      .catch((error: unknown) => {
        openedBotId.current = null;
        console.error("Failed to open bot", error);
      });
  }, [bot, openBot]);

  return { bot, pending: botsQuery.isPending || openBot.isPending };
}

function BotChatRoute(): JSX.Element {
  const { botId } = botRoute.useParams();
  const { bot, pending } = useOpenRoutedBot(botId);
  if (bot == null && pending) return <RouteLoading />;
  return <ChatPanel />;
}

function EditBotRoute(): JSX.Element {
  const { botId } = editBotRoute.useParams();
  const navigate = editBotRoute.useNavigate();
  const { bot, pending } = useOpenRoutedBot(botId);
  const [open, setOpen] = useState(true);

  if (bot == null && pending) return <RouteLoading />;
  return (
    <>
      <ChatPanel />
      <BotDialog
        isOpen={open && bot != null}
        bot={bot}
        onClose={() => {
          setOpen(false);
          void navigate({ to: "/bots/$botId", params: { botId } });
        }}
      />
    </>
  );
}

const RouteLoading = (): JSX.Element => (
  <div className="flex h-full items-center justify-center">
    <Spinner />
  </div>
);

/**
 * Inside the workspace shell so the sidebar and open chat stay put; the
 * /settings URLs stay because the tour, onboarding and settings rail use them.
 */
const capabilitiesLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_capabilities",
  component: CapabilitiesPane,
  staticData: { workspaceKind: "settings" },
});

const inPaneLayoutRoute = createRoute({
  getParentRoute: () => workspaceShellRoute,
  id: "_inPane",
  component: PlainPane,
  staticData: { workspaceKind: "settings" },
});

const settingsIndexRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings",
  beforeLoad: () => {
    // A bare /settings lands on a page of its own, not connectors.
    throw redirect({
      to: "/settings/account",
      replace: true,
    });
  },
});

const connectorsRoute = createRoute({
  getParentRoute: () => capabilitiesLayoutRoute,
  path: "/settings/connectors",
  staticData: { titleKey: "sidebarNav.connectors" },
  component: ConnectorsPanel,
});

const skillsRoute = createRoute({
  getParentRoute: () => capabilitiesLayoutRoute,
  path: "/settings/skills",
  staticData: { titleKey: "skills.title" },
  component: SkillsManagementPanel,
});

const toolsRoute = createRoute({
  getParentRoute: () => capabilitiesLayoutRoute,
  path: "/settings/tools",
  staticData: { titleKey: "capabilities.tabs.tools" },
  component: Outlet,
});

const toolsIndexRoute = createRoute({
  getParentRoute: () => toolsRoute,
  path: "/",
  component: ToolsPanel,
});

const toolsetRoute = createRoute({
  getParentRoute: () => toolsRoute,
  path: "$toolsetId",
  beforeLoad: ({ params }) => {
    if (!TOOLSETS_BY_ID.has(params.toolsetId)) {
      throw redirect({ to: "/settings/tools", replace: true });
    }
  },
  staticData: {
    titleKey: (params) => {
      const toolset = TOOLSETS_BY_ID.get(params.toolsetId ?? "");
      return toolset == null
        ? undefined
        : `capabilities.toolsets.${toolset.labelKey}.label`;
    },
    backTo: "/settings/tools",
  },
  component: SettingsToolsetRoute,
});

function SettingsToolsetRoute(): JSX.Element {
  const { toolsetId } = toolsetRoute.useParams();
  return <ToolsetPanel toolset={TOOLSETS_BY_ID.get(toolsetId)!} />;
}

const mcpRoute = createRoute({
  getParentRoute: () => capabilitiesLayoutRoute,
  path: "/settings/mcp",
  staticData: { titleKey: "capabilities.tabs.mcp" },
  component: SettingsMcpRoute,
});

function SettingsMcpRoute(): JSX.Element {
  return (
    <FocusedPage data-id="mcp-settings-page">
      <FocusedPageBody>
        <McpManagementPanel active />
      </FocusedPageBody>
    </FocusedPage>
  );
}

/**
 * The sidebar nav's own destinations belong in the pane too: each is a way
 * into a session, so the session list has to stay beside them.
 */
const jobsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/jobs",
  staticData: { titleKey: "sidebarNav.routines" },
  component: RoutinesPanel,
});

const artifactsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/artifacts",
  staticData: { titleKey: "sidebarNav.artifacts" },
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(sessionArtifactsQueryOptions()),
      context.queryClient.ensureQueryData(allAgentSessionsQueryOptions()),
    ]),
  component: ArtifactsPanel,
});

const memoryRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/memory",
  staticData: { titleKey: "sidebarNav.memory" },
  component: MemoryPanel,
});

const usageRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/usage",
  staticData: { titleKey: "sidebarNav.usage" },
  component: UsagePanel,
});

const changelogRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/changelog",
  staticData: { titleKey: "sidebarNav.whatsNew" },
  component: ChangelogPanel,
});

const accountRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/account",
  staticData: { titleKey: "profile.title" },
  component: ProfilePanel,
});

const modelsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/models",
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.provider === "string" &&
    (search.provider === "local" ||
      PROVIDER_KEY_FIELDS.some((field) => field.provider === search.provider))
      ? { provider: search.provider }
      : {},
  staticData: { titleKey: "apiKeys.title" },
  component: ModelsRoute,
});

function ModelsRoute(): JSX.Element {
  const { provider } = modelsRoute.useSearch();
  const navigate = modelsRoute.useNavigate();
  return (
    <ModelsSettingsPanel
      provider={provider}
      onProviderChange={(nextProvider) =>
        void navigate({
          search: nextProvider == null ? {} : { provider: nextProvider },
          replace: true,
        })
      }
    />
  );
}

const browserSettingsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/browser",
  staticData: { titleKey: "browserSettings.title" },
  component: BrowserSettingsPanel,
});

const deviceSettingsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/devices",
  staticData: { titleKey: "deviceSettings.title" },
  component: DeviceSettingsPanel,
});

const notificationSettingsRoute = createRoute({
  getParentRoute: () => inPaneLayoutRoute,
  path: "/settings/notifications",
  staticData: { titleKey: "notificationSettings.title" },
  component: NotificationSettingsPanel,
});

const routeTree = rootRoute.addChildren([
  workspaceShellRoute.addChildren([
    codingLayoutRoute.addChildren([workspaceRoute]),
    sessionsLayoutRoute.addChildren([newSessionRoute, sessionRoute]),
    botsLayoutRoute.addChildren([newBotRoute, botRoute, editBotRoute]),
    routinesLayoutRoute.addChildren([routineRoute]),
    capabilitiesLayoutRoute.addChildren([
      connectorsRoute,
      skillsRoute,
      toolsRoute.addChildren([toolsIndexRoute, toolsetRoute]),
      mcpRoute,
    ]),
    inPaneLayoutRoute.addChildren([
      settingsIndexRoute,
      modelsRoute,
      jobsRoute,
      artifactsRoute,
      memoryRoute,
      usageRoute,
      changelogRoute,
      accountRoute,
      browserSettingsRoute,
      deviceSettingsRoute,
      notificationSettingsRoute,
    ]),
  ]),
]);

export const createAppRouter = (
  queryClient: QueryClient,
  history: RouterHistory = createHashHistory()
) =>
  createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
