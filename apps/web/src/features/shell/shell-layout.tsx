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
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  PaneBoundary,
  PaneError,
  RoutePending,
} from "#renderer/components/page-state";
import { useDb } from "#renderer/data/db";
import { createPaneWidthWriter, usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#renderer/ui/resizable";

import { BAND_WIDTH, useShellBand } from "./breakpoints";
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
  setPanelOpen,
  type PanelTabKind,
} from "./panel-store";
import { Rail } from "./rail";
import {
  closeFloating,
  createFloatingIntent,
  rememberLocation,
} from "./shell-store";
import {
  clampPanelWidth,
  PANE_MIN_PX,
  PANEL_DEFAULT_PX,
  PANEL_MIN_PX,
  PANEL_PREF_KEY,
  panelMaxFor,
  SidePanelBody,
  SidePanelDrawer,
  SidePanelFrame,
  usePanelTabTitle,
} from "./side-panel";
import { useSidePanelOverride } from "./side-panel-slot";
import { SidebarSlot } from "./sidebar-slot";
import { TopBar } from "./top-bar";
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
  const band = useShellBand();
  const prefs = usePrefs();
  const db = useDb();
  const { area, sidebar } = useShellMatch();
  const panel = usePanel(area);
  const overridden = useSidePanelOverride();
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
    panelOpen:
      area === "sessions"
        ? (location.search as { tab?: string }).tab != null
        : panel.open,
    view: (location.search as { view?: string }).view,
  });
  const panelKinds: readonly PanelTabKind[] =
    area == null ? [] : AREA_PANEL_KINDS[area];
  const panelShown = !overridden && area !== "sessions" && panel.open;
  const panelInLayout = panelShown && layout.sidePanel === "layout";
  const scopeKey = panel.key;
  const strip =
    panelInLayout && scopeKey != null ? (
      <TopBar.PanelTabs
        tabs={panel.scope.tabs}
        active={panel.scope.active}
        title={tabTitle}
        kinds={panelKinds}
        onChange={(id) => activatePanelTab(scopeKey, id)}
        onClose={(id) => closePanelTab(scopeKey, id)}
        onReorder={(ids) => reorderPanelTabs(scopeKey, ids)}
        // "+" on a multi-instance kind is a new tab (a browser's new-tab
        // page), never a refocus of the one already open.
        onAdd={(kind) => openPanelTab(scopeKey, { kind }, { fresh: true })}
      />
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

  const [paneWidth] = useState(() => createPaneWidthWriter(db, PANEL_PREF_KEY));
  // The split's width bounds the panel (60 %, 960 px, the pane's minimum).
  const group = useRef<HTMLDivElement>(null);
  const [groupWidth, setGroupWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = group.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setGroupWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const panelMax = panelMaxFor(groupWidth);
  const storedPanel = clampPanelWidth(
    prefs.panes[PANEL_PREF_KEY] ?? PANEL_DEFAULT_PX,
    panelMax
  );

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
              tabs={panelInLayout ? panelKinds : []}
            />
            {strip}
            <TopBar.PanelToggle open={panelShown} onToggle={panel.toggle} />
          </TopBar.Root>
          {panelInLayout && scopeKey != null && (
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
              ref={group}
              className={cn(
                "flex min-h-0 min-w-0 flex-1",
                // A phone's pane runs edge to edge, like a native screen.
                !phone && "pr-(--pane-inset) pb-(--pane-inset)"
              )}
            >
              <ResizablePanelGroup orientation="horizontal" className="gap-0">
                <ResizablePanel id="pane" minSize={PANE_MIN_PX}>
                  <Pane>
                    <PaneBoundary resetKey={location.pathname}>
                      {children ?? <Outlet />}
                    </PaneBoundary>
                  </Pane>
                </ResizablePanel>
                {panelInLayout && (
                  <>
                    <ResizableHandle
                      data-pane-gutter=""
                      className="w-(--pane-inset) bg-transparent"
                    />
                    <ResizablePanel
                      id="side-panel"
                      minSize={PANEL_MIN_PX}
                      maxSize={panelMax}
                      defaultSize={storedPanel}
                      onResize={(size) =>
                        paneWidth.write(
                          clampPanelWidth(size.inPixels, panelMax)
                        )
                      }
                    >
                      <SidePanelFrame>
                        <PaneBoundary resetKey={scopeKey ?? ""}>
                          <SidePanelBody tab={panel.active} />
                        </PaneBoundary>
                      </SidePanelFrame>
                    </ResizablePanel>
                  </>
                )}
              </ResizablePanelGroup>
            </div>
          </div>
          <SidePanelDrawer
            open={panelShown && layout.sidePanel === "drawer"}
            tabs={panel.scope.tabs}
            active={panel.active}
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
