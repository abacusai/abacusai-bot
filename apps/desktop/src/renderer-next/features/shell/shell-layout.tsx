/**
 * The shell (spec 01 §7): title bar, rail, sidebar slot, content pane and side
 * panel, laid out by the pure `shellLayout` from the width band, the area,
 * `prefs.sidebar.pinned` and `search.tab`. Mirrors the band to
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
} from "@tanstack/react-router";
import { useEffect, useState, type CSSProperties } from "react";

import { useDb } from "#next/data/db";
import { createPaneWidthWriter, usePrefs } from "#next/data/db/prefs";
import {
  AREA_PANEL_TABS,
  type SidePanelTabId,
} from "#next/lib/navigation/search";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "#next/ui/resizable";

import { BAND_WIDTH, useShellBand } from "./breakpoints";
import { FloatingIntentContext } from "./floating-intent";
import { shellLayout, type ShellArea } from "./layout";
import { Rail } from "./rail";
import {
  closeFloating,
  createFloatingIntent,
  rememberLocation,
  rememberTab,
} from "./shell-store";
import {
  PANE_MIN_PX,
  PANEL_DEFAULT_PX,
  PANEL_MIN_PX,
  PANEL_PREF_KEY,
  SidePanelBody,
  SidePanelDrawer,
  SidePanelFrame,
} from "./side-panel";
import { SidebarSlot } from "./sidebar-slot";
import { TopBar } from "./top-bar";
import { useTopBarStatus } from "./top-bar-slots";
import { usePanel } from "./use-panel";
import { useShellMatch } from "./use-shell-match";
import { useSidebarToggle } from "./use-sidebar-toggle";

const Pane = () => (
  <main
    data-slot="pane"
    className="pane bg-background text-foreground relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--pane-radius)"
  >
    <div
      data-slot="pane-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-auto"
    >
      <Outlet />
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

const focusInsideFloating = (): boolean =>
  document.activeElement?.closest(FLOATING_SELECTOR) != null;

export interface ShellLayoutProps {
  /** Dev only: the chrome reported overlay-unavailable. */
  geometryMissing?: boolean;
  initials?: string;
}

export const ShellLayout = ({
  geometryMissing = false,
  initials = "",
}: ShellLayoutProps) => {
  const band = useShellBand();
  const prefs = usePrefs();
  const db = useDb();
  const { area, sidebar } = useShellMatch();
  const panel = usePanel(area);
  const location = useLocation();
  const router = useRouter();
  const status = useTopBarStatus();
  const sidebarToggle = useSidebarToggle();
  const [intent] = useState(() => createFloatingIntent(focusInsideFloating));

  const layout = shellLayout({
    width: BAND_WIDTH[band],
    area,
    pinned: prefs.sidebar.pinned,
    panelOpen: panel.tab != null,
  });
  const panelTabs: readonly SidePanelTabId[] =
    area == null ? [] : AREA_PANEL_TABS[area];
  const panelInLayout = layout.sidePanel === "layout" && panel.tab != null;

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
  useEffect(() => {
    intent.cancel();
    closeFloating();
    const owner = areaOf(router, pathname);
    if (owner != null)
      rememberLocation(owner, {
        pathname,
        search: JSON.parse(searchKey) as Record<string, unknown>,
      });
  }, [pathname, searchKey, router, intent]);

  useEffect(() => {
    if (area != null && panel.tab != null) rememberTab(area, panel.tab);
  }, [area, panel.tab]);

  // Floating no longer applies (pinned, strip): nothing may open it later.
  const floatingEnabled = layout.sidebar === "floating";
  useEffect(() => {
    if (floatingEnabled) return;
    intent.cancel();
    closeFloating();
  }, [floatingEnabled, intent]);
  useEffect(() => intent.cancel, [intent]);

  const [paneWidth] = useState(() => createPaneWidthWriter(db, PANEL_PREF_KEY));
  const storedPanel = prefs.panes[PANEL_PREF_KEY] ?? PANEL_DEFAULT_PX;

  return (
    <FloatingIntentContext value={intent}>
      <div
        data-slot="shell"
        data-band={band}
        data-sidebar={layout.sidebar}
        className="shell-surface text-sidebar-foreground grid h-dvh grid-rows-[var(--toolbar-h)_minmax(0,1fr)] overflow-hidden"
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
          <TopBar.Actions folded={layout.titleBar.actionsFolded} />
          {panelInLayout && panel.tab != null && (
            <TopBar.PanelTabs
              tabs={panelTabs}
              value={panel.tab}
              onChange={panel.setTab}
            />
          )}
          <TopBar.PanelToggle
            open={panel.tab != null}
            onToggle={panel.toggle}
          />
        </TopBar.Root>
        <div className="relative flex min-h-0">
          <Rail
            area={area}
            floatingEnabled={floatingEnabled}
            initials={initials}
          />
          <SidebarSlot
            mode={layout.sidebar}
            sidebarId={sidebar}
            onEscape={() => closeFloating()}
          />
          <div className="flex min-h-0 min-w-0 flex-1 pr-(--pane-inset) pb-(--pane-inset)">
            <ResizablePanelGroup orientation="horizontal" className="gap-0">
              <ResizablePanel id="pane" minSize={PANE_MIN_PX}>
                <Pane />
              </ResizablePanel>
              {panelInLayout && panel.tab != null && (
                <>
                  <ResizableHandle
                    data-pane-gutter=""
                    className="w-(--pane-inset) bg-transparent"
                  />
                  <ResizablePanel
                    id="side-panel"
                    minSize={PANEL_MIN_PX}
                    defaultSize={storedPanel}
                    onResize={(size) => paneWidth.write(size.inPixels)}
                  >
                    <SidePanelFrame>
                      <SidePanelBody tab={panel.tab} />
                    </SidePanelFrame>
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </div>
        </div>
        <SidePanelDrawer
          open={layout.sidePanel === "drawer"}
          tab={panel.tab}
          tabs={panelTabs}
          onTabChange={panel.setTab}
          onClose={() => panel.setTab(undefined)}
        />
      </div>
    </FloatingIntentContext>
  );
};
