import { useNavigate, useRouterState } from "@tanstack/react-router";
import { CalendarClock, FileText, PanelLeft, Plug } from "lucide-react";
import { type CSSProperties, type JSX } from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { useSidebarConversationRoute } from "../../lib/sidebar-conversation-route";
import { TITLEBAR_START_INSET } from "../../lib/window-chrome";
import { useSidebarAccordion } from "../../stores/sidebar-accordion-store";
import { BotsTree } from "../bots/bots-tree";
import { AbacusBotLogo } from "../brand/abacus-bot-logo";
import { RoutinesTree } from "../routines/routines-tree";
import { SettingsMenu } from "../settings/settings-menu";
import { Button } from "../ui";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from "../ui/sidebar";
import { SessionsTree } from "../workspace/sessions-tree";
import { CreditsExhaustedCard } from "./credits-exhausted-card";
import { DeepAgentCard } from "./deepagent-card";
import { ReferralCard } from "./referral-card";
/**
 * The sidebar: the bots tree, then the app-level stack at the bottom.
 * Artifacts, routines and connectors sit there with settings because they are
 * places you look something up, not places you work; each opens in the pane.
 * A pending update joins the stack (the title bar's pill takes over collapsed).
 */

export const WorkspaceSidebar = ({
  static: isStatic = false,
  visible = true,
  onToggle,
}: {
  static?: boolean;
  visible?: boolean;
  onToggle?: () => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Which of these places you are already in, so the stack can mark it.
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  // The section holding the conversation on screen opens itself: a + in a
  // folded section, or a bot opened from its home page, would otherwise
  // select a row the sidebar was not showing.
  const activeRoute = useSidebarConversationRoute();
  const revealSection = useSidebarAccordion((state) => state.revealSection);
  const activeKind = activeRoute?.kind ?? null;
  const activeId = activeRoute?.id ?? null;
  useEffect(() => {
    if (activeKind === "bot") revealSection("bots");
    else if (activeKind === "routine") revealSection("routines");
    else if (activeKind === "session") revealSection("sessions");
  }, [activeKind, activeId, revealSection]);

  return (
    <Sidebar
      collapsible={isStatic ? "none" : "offcanvas"}
      className="bg-sidebar/80 [&_[data-slot=sidebar-inner]]:bg-sidebar/80 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:[&_[data-slot=sidebar-inner]]:bg-sidebar/70 min-w-0 overflow-hidden data-[slot=sidebar]:w-full supports-[backdrop-filter]:backdrop-blur-xl"
      data-id="workspace-sidebar"
    >
      <SidebarHeader
        className="border-border h-(--workspace-topbar-height) justify-center border-b p-0 pe-2"
        style={
          {
            paddingLeft: TITLEBAR_START_INSET,
            WebkitAppRegion: "drag",
          } as CSSProperties
        }
      >
        <div className="flex min-w-0 items-center gap-1">
          <AbacusBotLogo
            dataId="abacusai-bot-logo-local-code"
            className="min-w-0"
          />
          {isStatic ? (
            visible && (
              <Button
                variant="ghost"
                size="icon"
                data-id="local-code-sidebar-toggle"
                className="text-muted-foreground ms-auto shrink-0"
                aria-label={t("workspace.hideSidebar")}
                aria-pressed="true"
                onClick={onToggle}
                style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
              >
                <PanelLeft />
              </Button>
            )
          ) : (
            <SidebarTrigger
              data-id="local-code-sidebar-toggle"
              className="text-muted-foreground ms-auto shrink-0"
              aria-label={t("workspace.hideSidebar")}
              aria-pressed="true"
              style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            >
              <PanelLeft />
            </SidebarTrigger>
          )}
        </div>
      </SidebarHeader>
      {/* The column does not scroll; one section does. This is the DeepAgent
          web app's Projects / Chats / Agent Sessions accordion: every header
          is always on screen, exactly one section is open, and it scrolls
          inside itself while the others fold to their header line.
          An open section sizes to its rows and shrinks only when they do not
          fit. Growing to fill would strand a few rows above a column of empty
          space with Sessions pinned to the bottom edge. Sizing is flex with
          min-h-0, not measured pixels. */}
      <SidebarContent className="gap-0 overflow-hidden">
        {/* Two sections, not a toggle. A session is a bot you did not name,
            so the two belong in one column as two lists of the same shape.
            A toggle hides whichever you are not looking at. */}
        {/* The pair is one thing to the tour ("what you have here"), so it
            gets a wrapper to spotlight. Highlighting the bots alone would
            describe sessions while pointing away from them. */}
        <div className="flex min-h-0 flex-1 flex-col" data-id="sidebar-lists">
          <div className="flex min-h-0 flex-col" data-id="bots-list">
            <BotsTree />
          </div>
          {/* Between the two, and absent until there is one: a routine is
              something a bot was given, so it reads as belonging under them,
              and an empty section is a heading that only ever says "none". */}
          <RoutinesTree />
          <SessionsTree />
        </div>
      </SidebarContent>

      <SidebarFooter className="gap-0 p-0">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    void navigate({ to: "/settings/artifacts" });
                  }}
                  data-id="sidebar-nav-artifacts"
                  isActive={pathname === "/settings/artifacts"}
                >
                  <FileText />
                  <span>{t("sidebarNav.artifacts")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    void navigate({ to: "/settings/jobs" });
                  }}
                  data-id="sidebar-nav-routines"
                  isActive={pathname === "/settings/jobs"}
                >
                  <CalendarClock />
                  <span>{t("sidebarNav.routines")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  onClick={() => {
                    void navigate({
                      to: "/settings/connectors",
                    });
                  }}
                  data-id="sidebar-nav-connectors"
                  isActive={pathname === "/settings/connectors"}
                >
                  <Plug />
                  <span>{t("sidebarNav.connectors")}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <DeepAgentCard />
        <ReferralCard />
        <CreditsExhaustedCard />
        <SettingsMenu />
      </SidebarFooter>
    </Sidebar>
  );
};
