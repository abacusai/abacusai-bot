import { useNavigate, useRouterState } from "@tanstack/react-router";
import { PanelLeft, PanelRight, SquarePen, SquareTerminal } from "lucide-react";
import { CSSProperties, JSX } from "react";
import { useTranslation } from "react-i18next";

import { useBotsQuery } from "../../hooks/use-bots";
import { useWorkspaceAgentSessionsQuery } from "../../hooks/use-workspace-queries";
import { useSessionTurnStateQuery } from "../../hooks/use-workspace-queries";
import { usePaneTitleKey } from "../../lib/pane-title";
import {
  TITLEBAR_CONTENT_END_INSET,
  TITLEBAR_END_INSET,
  TITLEBAR_HEIGHT,
  TITLEBAR_START_INSET,
  titlebarStartInset,
} from "../../lib/window-chrome";
import type { WorkspaceRouteKind } from "../../lib/workspace-route";
import {
  useWorkspaceActiveWorkspaceId,
  useWorkspaceMetadata,
  useWorkspaceWorkspaceActions,
} from "../../providers/workspace-state-provider";
import { useWorkspaceStore } from "../../stores/code-store";
import { BotAvatar } from "../bots/bot-avatar";
import { AbacusBotLogo } from "../brand/abacus-bot-logo";
import { WorkspacePicker } from "../chat/workspace-picker";
import { UpdatePill } from "../common/update-pill";
import { Button } from "../ui";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useConversationActivator } from "../workspace/workspace-activation";

export function TitleBar({
  routeKind,
  compact,
  compactInspectorOpen,
  inspectorOpen,
  terminalOpen,
  onToggleRightPanel,
  onToggleTerminal,
}: {
  routeKind: WorkspaceRouteKind;
  compact: boolean;
  compactInspectorOpen: boolean;
  inspectorOpen: boolean;
  terminalOpen: boolean;
  onToggleRightPanel: () => void;
  onToggleTerminal: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const { isMobile, open, openMobile } = useSidebar();

  const newPaneIntent = useWorkspaceStore((state) => state.newPaneIntent);
  const setActiveSessionId = useWorkspaceStore(
    (state) => state.setActiveSessionId
  );
  const getActiveSessionId = useWorkspaceStore(
    (state) => state.getActiveSessionId
  );

  const activateSelection = useConversationActivator();
  const metadataQuery = useWorkspaceMetadata();
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const { addLocalWorkspace } = useWorkspaceWorkspaceActions(activeWorkspaceId);
  const activeSessionId =
    activeWorkspaceId == null ? null : getActiveSessionId(activeWorkspaceId);
  const sessionsQuery = useWorkspaceAgentSessionsQuery(activeWorkspaceId);
  const activeWorkspace = metadataQuery.data?.workspaces?.find(
    (workspace) => workspace.id === activeWorkspaceId
  );
  const activeSession = sessionsQuery.data?.find(
    (session) => session.id === activeSessionId
  );
  const hasActiveSession = activeSessionId != null;
  // What the pane is showing when it is not the chat, or the breadcrumb falls
  // through to "New chat" over Messaging, Artifacts or Usage.
  const paneTitleKey = usePaneTitleKey();
  const navigate = useNavigate();

  const sidebarShown = isMobile ? openMobile : open;
  const inspectorShown = compact ? compactInspectorOpen : inspectorOpen;
  // The terminal needs a conversation to attach to; pane destinations like
  // Artifacts and Usage have none.
  const terminalShown = routeKind === "session" && paneTitleKey == null;
  const inspectorAllowed = routeKind !== "settings";
  // The bots pane has its own folder whether or not a project is open, so an
  // active workspace is not what makes the toggle live there.
  const terminalReady = activeWorkspaceId != null || newPaneIntent === "bot";
  const switchWorkspace = (workspaceId: string): void => {
    activateSelection({ workspaceId, sessionId: null });
  };

  return (
    <header
      className="border-border bg-background/80 h-(--workspace-topbar-height) shrink-0 border-b backdrop-blur-xl"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <div
        className="flex h-full min-w-0 items-center"
        style={{
          paddingLeft:
            sidebarShown && !isMobile
              ? 16
              : titlebarStartInset(hasActiveSession ? 92 : 60),
          paddingRight: inspectorShown
            ? TITLEBAR_CONTENT_END_INSET
            : TITLEBAR_END_INSET,
        }}
      >
        <div className="flex min-w-0 items-center gap-2 text-xs">
          {routeKind === "bot" ? (
            <BotTitleIdentity />
          ) : paneTitleKey != null ? (
            // Not showing a chat, so the session breadcrumb would be wrong.

            <span className="text-foreground max-w-72 truncate font-medium">
              {t(paneTitleKey)}
            </span>
          ) : (
            activeWorkspace != null && (
              <>
                <div style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
                  <WorkspacePicker
                    workspaces={metadataQuery.data?.workspaces ?? []}
                    activeWorkspaceId={activeWorkspaceId}
                    onSwitchWorkspace={switchWorkspace}
                    onAddWorkspace={() => void addLocalWorkspace()}
                    variant="titlebar"
                  />
                </div>
                <span aria-hidden className="text-muted-foreground/50">
                  /
                </span>
                <span className="text-foreground max-w-72 truncate font-medium">
                  {/* No session means one of the two + buttons was pressed and
                      the pane is showing what it asks for: a bot's name, or a
                      workspace to start a session in. */}
                  {activeSession?.label ??
                    (newPaneIntent === "bot"
                      ? t("workspace.newBot")
                      : t("workspace.newChat"))}
                </span>
              </>
            )
          )}
        </div>

        <div
          className="ms-auto flex h-full shrink-0 items-center gap-0.5"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          {!sidebarShown && <UpdatePill />}
          {routeKind === "session" && sidebarShown && hasActiveSession && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    data-id="local-code-new-chat"
                    onClick={() => {
                      setActiveSessionId(activeWorkspaceId!, null);
                      // The composer is not on screen while a pane destination
                      // is showing, so clearing the session is not enough.
                      void navigate({ to: "/sessions/new" });
                    }}
                    className="text-muted-foreground"
                    aria-label={t("workspace.newChat")}
                  >
                    <SquarePen />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {t("workspace.newChat")}
              </TooltipContent>
            </Tooltip>
          )}
          {terminalShown && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon"
                    onClick={terminalReady ? onToggleTerminal : undefined}
                    data-id="local-code-bottom-panel-toggle"
                    disabled={!terminalReady}
                    variant={terminalOpen ? "secondary" : "ghost"}
                    className="text-muted-foreground"
                    aria-label={
                      terminalOpen
                        ? t("workspace.hideTerminal")
                        : t("workspace.showTerminal")
                    }
                    aria-pressed={terminalOpen}
                  >
                    <SquareTerminal />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {!terminalReady
                  ? t("workspace.terminalRequiresWorkspace")
                  : terminalOpen
                    ? t("workspace.hideTerminal")
                    : t("workspace.showTerminal")}
              </TooltipContent>
            </Tooltip>
          )}
          {inspectorAllowed && !inspectorShown && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleRightPanel}
                    data-id="local-code-right-sidebar-toggle"
                    className="text-muted-foreground"
                    aria-label={t("workspace.showRightPanel")}
                    aria-pressed={false}
                  >
                    <PanelRight className="rtl:rotate-180" />
                  </Button>
                }
              />
              <TooltipContent side="bottom">
                {t("workspace.showRightPanel")}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    </header>
  );
}

const useRouteEntityId = (prefix: "bots"): string | null =>
  useRouterState({
    select: (state) =>
      state.location.pathname.match(new RegExp(`^/${prefix}/([^/]+)`))?.[1] ??
      null,
  });

const BotTitleIdentity = (): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const botId = useRouteEntityId("bots");
  const bot = useBotsQuery().data?.find((entry) => entry.id === botId) ?? null;
  const working =
    useSessionTurnStateQuery(bot?.workspaceId ?? null, bot?.sessionId ?? null)
      .data?.isBusy === true;

  if (bot == null) {
    return (
      <span className="text-foreground font-medium">
        {t("workspace.newBot")}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-id="titlebar-edit-bot"
      className="hover:bg-muted flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-start"
      onClick={() =>
        void navigate({
          to: "/bots/$botId/edit",
          params: { botId: bot.id },
        })
      }
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <BotAvatar
        seed={`${bot.id}:${bot.name}`}
        color={bot.avatarColor}
        shape={bot.avatarShape}
        size={24}
        active={working}
      />
      <span className="min-w-0">
        <span className="block max-w-56 truncate font-medium">{bot.name}</span>
        {bot.title.length > 0 && (
          <span className="text-muted-foreground block max-w-56 truncate text-[10px]">
            {bot.title}
          </span>
        )}
      </span>
    </button>
  );
};

export function SidebarControl({
  compact,
  onToggle,
}: {
  compact: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isMobile, open, openMobile } = useSidebar();
  const sidebarShown = isMobile ? openMobile : open;
  const activeWorkspaceId = useWorkspaceActiveWorkspaceId();
  const activeSessionId = useWorkspaceStore((state) =>
    activeWorkspaceId == null
      ? null
      : (state.workspaceUiStates[activeWorkspaceId]?.activeSessionId ?? null)
  );
  const setActiveSessionId = useWorkspaceStore(
    (state) => state.setActiveSessionId
  );
  const sharedProps = {
    "data-id": "local-code-sidebar-toggle",
    className: "text-muted-foreground",
    "aria-label": sidebarShown
      ? t("workspace.hideSidebar")
      : t("workspace.showSidebar"),
    "aria-pressed": sidebarShown,
  };

  if (sidebarShown) return <></>;

  return (
    <div
      className="fixed z-30 flex items-center gap-0.5"
      style={
        {
          WebkitAppRegion: "no-drag",
          left: TITLEBAR_START_INSET,
          top: (TITLEBAR_HEIGHT - 28) / 2,
        } as CSSProperties
      }
    >
      <AbacusBotLogo markOnly size={20} />
      <Tooltip>
        <TooltipTrigger
          render={
            compact ? (
              <SidebarTrigger {...sharedProps} size="icon" />
            ) : (
              <Button
                {...sharedProps}
                variant="ghost"
                size="icon"
                onClick={onToggle}
              >
                <PanelLeft />
              </Button>
            )
          }
        />
        <TooltipContent side="bottom">
          {sidebarShown
            ? t("workspace.hideSidebar")
            : t("workspace.showSidebar")}
        </TooltipContent>
      </Tooltip>
      {activeWorkspaceId != null && activeSessionId != null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                data-id="local-code-new-chat"
                onClick={() => {
                  setActiveSessionId(activeWorkspaceId, null);
                  void navigate({ to: "/sessions/new" });
                }}
                className="text-muted-foreground"
                aria-label={t("workspace.newChat")}
              >
                <SquarePen />
              </Button>
            }
          />
          <TooltipContent side="bottom">
            {t("workspace.newChat")}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
