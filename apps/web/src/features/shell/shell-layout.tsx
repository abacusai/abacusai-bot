/**
 * The shell (spec 01 §7): title bar, rail, sidebar slot, content pane and side
 * panel, laid out by the pure `shellLayout` from the width band, the area,
 * `prefs.sidebar.pinned` and the panel scope's open state (`panelStore`;
 * sessions keep `search.tab` for their dock). Mirrors the band to
 * `html[data-band]` and the sidebar's in-layout width to
 * `--sidebar-occupied-w` (the title bar aligns the identity with the pane).
 *
 * The pane always sits at the same place in the tree, the first panel of one
 * resizable group, whether the side panel is in layout, a drawer or closed
 * (Codex/Claude impl r1 #3/#1): opening the panel, closing it or crossing
 * 1100 px adds or removes a sibling, never re-parents the route subtree, so
 * its state and scroll survive.
 */
import {
  Outlet,
  useLocation,
  useRouter,
  type AnyRouter,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { Maximize, Minimize } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { BotTabAvatar } from "#renderer/components/bot-tab-avatar";
import {
  PaneBoundary,
  PaneError,
  RoutePending,
} from "#renderer/components/page-state";
import {
  PanelWorkspace,
  PANEL_DRAG_TYPE,
  moveDockTab,
} from "#renderer/components/panel-workspace";
import { usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";

import { BAND_WIDTH, useShellBand } from "./breakpoints";
import { UpgradePromo } from "./credits-card";
import { FloatingIntentContext } from "./floating-intent";
import { APP_HOTKEYS, useAppHotkey } from "./hotkeys";
import { shellLayout, type ShellArea } from "./layout";
import {
  activatePanelTab,
  AREA_PANEL_KINDS,
  closePanelTab,
  cyclePanelTab,
  openPanelTab,
  panelScope,
  reorderPanelTabs,
  reopenPanelTab,
  updatePanelTab,
  setPanelOpen,
  setPanelExpanded,
  type PanelTabKind,
} from "./panel-store";
import { Rail } from "./rail";
import {
  closeFloating,
  createFloatingIntent,
  rememberLocation,
} from "./shell-store";
import {
  SidePanelBody,
  SidePanelDrawer,
  SidePanelFrame,
  usePanelTabTitle,
} from "./side-panel";
import { useSidePanelFilled, useSidePanelOverride } from "./side-panel-slot";
import { SidebarSlot } from "./sidebar-slot";
import { TopBar } from "./top-bar";
import { TopBarPanelOutlet } from "./top-bar-slots";
import { useTopBarStatus } from "./top-bar-slots";
import { PanelScopeContext, usePanel } from "./use-panel";
import { useShellMatch } from "./use-shell-match";
import { useSidebarToggle } from "./use-sidebar-toggle";

const Pane = ({ children }: { children?: ReactNode }) => (
  <main
    data-slot="pane"
    className="pane bg-background text-foreground phone:rounded-none relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--pane-radius)"
  >
    <div
      data-slot="pane-scroll"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
    >
      {children ?? <Outlet />}
    </div>
  </main>
);

/**
 * The area a location belongs to, from the location itself: the location and
 * the matches reach components through separate subscriptions, so pairing
 * `useLocation()` with the current area could file a location under the
 * area being left.
 */
const areaOf = (router: AnyRouter, pathname: string): ShellArea | undefined => {
  const [matched] = router.getMatchedRoutes(pathname);
  let area: ShellArea | undefined;
  for (const route of matched)
    area =
      (route.options.staticData as { area?: ShellArea } | undefined)?.area ??
      area;
  return area;
};

const FLOATING_SELECTOR = '[data-slot="sidebar-floating"]';

/**
 * ⌘W closes the active panel tab, ⌘⇧] / ⌘⇧[ cycle them: registered only
 * while the strip shows outside sessions (the dock has its own). Keyboard
 * actions animate nothing.
 */
const PanelHotkeys = ({ scopeKey }: { scopeKey: string }) => {
  useAppHotkey(
    APP_HOTKEYS.closeTab,
    () => {
      const scope = panelScope(scopeKey);
      if (scope.active != null) closePanelTab(scopeKey, scope.active);
    },
    { actionId: "close-tab" }
  );
  useAppHotkey(APP_HOTKEYS.nextPanelTab, () => cyclePanelTab(scopeKey, 1), {
    actionId: "next-panel-tab",
  });
  useAppHotkey(
    APP_HOTKEYS.previousPanelTab,
    () => cyclePanelTab(scopeKey, -1),
    { actionId: "previous-panel-tab" }
  );
  return null;
};

const focusInsideFloating = (): boolean =>
  document.activeElement?.closest(FLOATING_SELECTOR) != null;

export interface ShellLayoutProps {
  /** Dev only: the chrome reported overlay-unavailable. */
  geometryMissing?: boolean;
  initials?: string;
  children?: ReactNode;
}

export const ShellLayout = ({
  geometryMissing = false,
  initials = "",
  children,
}: ShellLayoutProps) => {
  const { t } = useTranslation();
  const band = useShellBand();
  const prefs = usePrefs();
  const { area, sidebar } = useShellMatch();
  const panel = usePanel(area);
  const overridden = useSidePanelOverride();
  const botPanelFilled = useSidePanelFilled("details");
  const location = useLocation();
  const router = useRouter();
  const status = useTopBarStatus();
  const sidebarToggle = useSidebarToggle();
  const [intent] = useState(() => createFloatingIntent(focusInsideFloating));

  const tabTitle = usePanelTabTitle();
  const layout = shellLayout({
    width: BAND_WIDTH[band],
    area,
    pinned: prefs.sidebar.pinned,
    panelOpen: area === "sessions" ? panel.sessionOpen : panel.open,
    view: (location.search as { view?: string }).view,
  });
  const panelKinds: readonly PanelTabKind[] =
    area == null ? [] : AREA_PANEL_KINDS[area];
  const panelAvailable =
    area === "bots" &&
    /^\/bots\/[^/]+(?:\/chats\/[^/]+|\/check-in)?$/.test(location.pathname) &&
    botPanelFilled &&
    !overridden;
  const panelShown = panelAvailable && panel.open;
  const panelInLayout = panelShown && layout.sidePanel === "layout";
  const scopeKey = panel.key;
  const expanded = panelShown && panel.scope.expanded === true;
  const [groups, setGroups] = useState(1);
  const botId = scopeKey?.startsWith("bots:") ? scopeKey.slice(5) : undefined;
  const dockApi = useRef<import("dockview-react").DockviewApi | null>(null);
  const strip =
    panelShown && scopeKey != null ? (
      <>
        {(!expanded || groups === 1) && (
          <TopBar.PanelTabs
            tabs={
              expanded
                ? [
                    {
                      id: "chat",
                      kind: "thread",
                      title: t("sessions.dock.chat"),
                    },
                    ...panel.scope.tabs,
                  ]
                : panel.scope.tabs
            }
            active={panel.scope.active}
            renderIcon={(tab) =>
              tab.id === "chat" ? <BotTabAvatar botId={botId} /> : undefined
            }
            title={tabTitle}
            kinds={panelKinds}
            onDragStart={(id, event) =>
              event.dataTransfer.setData(PANEL_DRAG_TYPE, id)
            }
            workspaceApi={dockApi}
            onMove={
              expanded
                ? (id, position) => {
                    moveDockTab(dockApi.current, id, position);
                  }
                : undefined
            }
            onChange={(id) => activatePanelTab(scopeKey, id)}
            onRename={(id, title) => updatePanelTab(scopeKey, id, { title })}
            onReopen={() => reopenPanelTab(scopeKey)}
            onClose={(id) => closePanelTab(scopeKey, id)}
            onReorder={(ids) => reorderPanelTabs(scopeKey, ids)}
            // "+" on a multi-instance kind is a new tab (a browser's new-tab
            // page), never a refocus of the one already open.
            onAdd={(kind) => openPanelTab(scopeKey, { kind }, { fresh: true })}
          />
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessions.dock.full")}
          aria-pressed={expanded}
          onClick={() => setPanelExpanded(scopeKey, !expanded)}
        >
          {expanded ? <Minimize /> : <Maximize />}
        </Button>
      </>
    ) : null;

  useEffect(() => {
    document.documentElement.dataset.band = band;
  }, [band]);

  // Navigation closes the floating sidebar and drops any pending pointer
  // timer (a hover before a click must not reopen it on the next page); the
  // rail remembers the area's location as a route location, the background
  // for a masked pop-up.
  const shown = location.maskedLocation ?? location;
  const pathname = shown.pathname;
  const searchKey = JSON.stringify(shown.search);
  const phone = band === "xs";
  const lastOwner = useRef<ShellArea | undefined>(undefined);
  useEffect(() => {
    intent.cancel();
    const owner = areaOf(router, pathname);
    // A phone's drawer holds the rail: picking an area there shows its list,
    // so only a move within the area (picking an item) closes it.
    if (!(phone && owner !== lastOwner.current)) closeFloating();
    lastOwner.current = owner;
    if (owner != null)
      rememberLocation(owner, {
        pathname,
        search: JSON.parse(searchKey) as Record<string, unknown>,
      });
  }, [pathname, searchKey, router, intent, phone]);

  // Floating no longer applies (pinned, strip): nothing may open it later.
  const floatingEnabled = layout.sidebar === "floating";
  useEffect(() => {
    if (floatingEnabled) return;
    intent.cancel();
    closeFloating();
  }, [floatingEnabled, intent]);
  useEffect(() => intent.cancel, [intent]);

  return (
    <FloatingIntentContext value={intent}>
      <PanelScopeContext value={scopeKey}>
        <div
          data-slot="shell"
          data-band={band}
          data-sidebar={layout.sidebar}
          className={cn(
            "shell-surface text-sidebar-foreground grid h-dvh min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[var(--toolbar-h)_minmax(0,1fr)] overflow-hidden",
            // Clear the notch and the home indicator (viewport-fit=cover).
            phone &&
              "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          )}
          style={
            {
              "--sidebar-occupied-w": `${layout.sidebarOccupied}px`,
            } as CSSProperties
          }
        >
          <TopBar.Root>
            <TopBar.Leading
              sidebarInLayout={layout.sidebar !== "floating"}
              showAppName={layout.titleBar.appName}
              sidebarExpanded={
                floatingEnabled ? sidebarToggle.floatingOpen : undefined
              }
              onToggleSidebar={sidebarToggle.toggle}
            />
            <TopBar.Identity
              status={layout.titleBar.status}
              statusText={status ?? undefined}
              badge={geometryMissing ? <TopBar.GeometryBadge /> : undefined}
            />
            <TopBar.Actions
              folded={layout.titleBar.actionsFolded}
              tabs={panelShown ? panelKinds : []}
            />
            {strip}
            <TopBarPanelOutlet />
            {panelAvailable && (
              <TopBar.PanelToggle open={panelShown} onToggle={panel.toggle} />
            )}
          </TopBar.Root>
          {panelShown && scopeKey != null && (
            <PanelHotkeys scopeKey={scopeKey} />
          )}
          <div className="relative flex min-h-0 min-w-0">
            {!phone && (
              <Rail
                area={area}
                floatingEnabled={floatingEnabled}
                iconsOnly={prefs.appearance?.railIconsOnly === true}
                initials={initials}
              />
            )}
            <PaneBoundary resetKey={area}>
              <SidebarSlot
                mode={layout.sidebar}
                sidebarId={sidebar}
                onEscape={() => closeFloating()}
                rail={
                  phone ? (
                    <Rail
                      area={area}
                      floatingEnabled={false}
                      initials={initials}
                    />
                  ) : undefined
                }
              />
            </PaneBoundary>
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                // A phone's pane runs edge to edge, like a native screen.
                !phone && "pr-(--pane-inset) pb-(--pane-inset)"
              )}
            >
              <PanelWorkspace
                onReopen={() => {
                  if (scopeKey) reopenPanelTab(scopeKey);
                }}
                onRename={(id, title) => {
                  if (scopeKey) updatePanelTab(scopeKey, id, { title });
                }}
                onGroupCountChange={setGroups}
                onAdd={(kind) => {
                  if (scopeKey)
                    openPanelTab(scopeKey, { kind }, { fresh: true });
                }}
                scope={scopeKey ?? "shell"}
                apiRef={dockApi}
                active={panel.scope.active}
                open={panelInLayout || expanded}
                expanded={expanded}
                onSelect={(id) => {
                  if (scopeKey) activatePanelTab(scopeKey, id);
                }}
                onClose={(id) => {
                  if (scopeKey && id !== "chat") closePanelTab(scopeKey, id);
                }}
                tabs={[
                  {
                    id: "chat",
                    icon: <BotTabAvatar botId={botId} />,
                    title: t("sessions.dock.chat"),
                    content: () => (
                      <Pane>
                        <PaneBoundary resetKey={location.pathname}>
                          {children ?? <Outlet />}
                        </PaneBoundary>
                      </Pane>
                    ),
                  },
                  ...(panelAvailable
                    ? panel.scope.tabs.map((tab) => ({
                        id: tab.id,
                        title: tabTitle(tab),
                        content: (visible: boolean) => (
                          <SidePanelFrame visible={visible}>
                            <PaneBoundary resetKey={scopeKey ?? ""}>
                              <SidePanelBody tab={tab} visible={visible} />
                            </PaneBoundary>
                          </SidePanelFrame>
                        ),
                      }))
                    : []),
                ]}
              />
            </div>
          </div>
          {IS_ELECTRON && <UpgradePromo />}
          <SidePanelDrawer
            open={panelShown && layout.sidePanel === "drawer"}
            tabs={panel.scope.tabs}
            active={panel.active}
            onTabClose={(id) => {
              if (scopeKey) closePanelTab(scopeKey, id);
            }}
            onTabReorder={(ids) => {
              if (scopeKey) reorderPanelTabs(scopeKey, ids);
            }}
            onReopen={() => {
              if (scopeKey) reopenPanelTab(scopeKey);
            }}
            onTabChange={(id) => {
              if (scopeKey != null) activatePanelTab(scopeKey, id);
            }}
            onClose={() => {
              if (scopeKey != null) setPanelOpen(scopeKey, false);
            }}
          />
        </div>
      </PanelScopeContext>
    </FloatingIntentContext>
  );
};

export const ShellPending = () => (
  <ShellLayout>
    <RoutePending />
  </ShellLayout>
);
export const ShellFailure = (props: ErrorComponentProps) => (
  <ShellLayout>
    <PaneError {...props} />
  </ShellLayout>
);
