/**
 * The shell (spec 01 §7): title bar, rail, sidebar slot, content pane and side
 * panel, laid out by the pure `shellLayout` from the width band, the area,
 * `prefs.sidebar.pinned` and `search.tab`. Mirrors the band to
 * `html[data-band]` and the sidebar's in-layout width to
 * `--sidebar-occupied-w` (the title bar aligns the identity with the pane).
 */
import {
  Outlet,
  useLocation,
  useMatches,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import {
  useEffect,
  useState,
  ViewTransition,
  type CSSProperties,
  type ViewTransitionClassPerType,
} from "react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#next/data/collections";
import {
  createPaneWidthWriter,
  usePrefs,
  useUpdatePrefs,
} from "#next/data/collections/prefs";
import { paneKey } from "#next/lib/navigation/pane-key";
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
import { shellLayout, type ShellArea } from "./layout";
import { Rail } from "./rail";
import { closeFloating, rememberLocation } from "./shell-store";
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
import { useShellMatch } from "./use-shell-match";

/** Animated only for typed navigations; "none" otherwise (§6.7). */
export const PANE_VT: ViewTransitionClassPerType = {
  "nav-lateral": "pane",
  "nav-forward": "pane",
  "nav-back": "pane",
  "settings-in": "pane",
  "settings-out": "pane",
  default: "none",
};

/** The leaf match's pane key (search never enters it). */
export const usePaneKey = (): string =>
  useMatches({
    select: (matches) => {
      const leaf = matches.at(-1);
      return leaf == null
        ? ""
        : paneKey(leaf.routeId, leaf.params as Record<string, string>);
    },
  });

const Pane = ({ keyed }: { keyed: string }) => (
  <main
    data-slot="pane"
    className="pane bg-background text-foreground relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--pane-radius)"
  >
    <ViewTransition key={keyed} enter={PANE_VT} exit={PANE_VT} default="none">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Outlet />
      </div>
    </ViewTransition>
  </main>
);

export interface ShellLayoutProps {
  /** Dev only: the chrome reported overlay-unavailable. */
  geometryMissing?: boolean;
  initials?: string;
}

export const ShellLayout = ({
  geometryMissing = false,
  initials = "",
}: ShellLayoutProps) => {
  const { t } = useTranslation();
  const band = useShellBand();
  const prefs = usePrefs();
  const updatePrefs = useUpdatePrefs();
  const collections = useCollections();
  const { area, sidebar } = useShellMatch();
  const search = useSearch({ strict: false }) as { tab?: SidePanelTabId };
  const navigate = useNavigate();
  const location = useLocation();
  const keyed = usePaneKey();

  const layout = shellLayout({
    width: BAND_WIDTH[band],
    area,
    pinned: prefs.sidebar.pinned,
    panelOpen: search.tab != null,
  });
  const panelTabs: readonly SidePanelTabId[] =
    area == null ? [] : AREA_PANEL_TABS[area];

  useEffect(() => {
    document.documentElement.dataset.band = band;
  }, [band]);

  // Navigation closes the floating sidebar; the rail remembers the area's
  // last location.
  const href = location.href;
  useEffect(() => {
    closeFloating();
    if (area != null) rememberLocation(area as ShellArea, href);
  }, [href, area]);

  const setTab = (tab: SidePanelTabId | undefined): void => {
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, tab }),
      replace: true,
    } as never);
  };
  const togglePanel = (): void =>
    setTab(search.tab == null ? (panelTabs[0] ?? "details") : undefined);
  const togglePinned = (): void =>
    void updatePrefs((draft) => {
      draft.sidebar = { ...draft.sidebar, pinned: !draft.sidebar.pinned };
    }).catch(() => undefined);

  const [paneWidth] = useState(() =>
    createPaneWidthWriter(collections, PANEL_PREF_KEY)
  );
  const storedPanel = prefs.panes[PANEL_PREF_KEY] ?? PANEL_DEFAULT_PX;

  return (
    <div
      data-slot="shell"
      data-band={band}
      data-sidebar={layout.sidebar}
      className="bg-sidebar text-sidebar-foreground grid h-dvh grid-rows-[var(--toolbar-h)_minmax(0,1fr)] overflow-hidden"
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
          onToggleSidebar={togglePinned}
        />
        <TopBar.Identity
          status={layout.titleBar.status}
          statusText={t("shell.status.ready")}
          badge={geometryMissing ? <TopBar.GeometryBadge /> : undefined}
        />
        <TopBar.Actions folded={layout.titleBar.actionsFolded} />
        {layout.sidePanel === "layout" && search.tab != null && (
          <TopBar.PanelTabs
            tabs={panelTabs}
            value={search.tab}
            onChange={setTab}
          />
        )}
        <TopBar.PanelToggle open={search.tab != null} onToggle={togglePanel} />
      </TopBar.Root>
      <div className="relative flex min-h-0">
        <Rail
          area={area}
          floatingEnabled={layout.sidebar === "floating"}
          initials={initials}
        />
        <SidebarSlot mode={layout.sidebar} sidebarId={sidebar} />
        <div className="flex min-h-0 min-w-0 flex-1 pr-(--pane-inset) pb-(--pane-inset)">
          {layout.sidePanel === "layout" && search.tab != null ? (
            <ResizablePanelGroup orientation="horizontal" className="gap-0">
              <ResizablePanel id="pane" minSize={PANE_MIN_PX}>
                <Pane keyed={keyed} />
              </ResizablePanel>
              <ResizableHandle className="mx-0 w-px bg-transparent" />
              <ResizablePanel
                id="side-panel"
                minSize={PANEL_MIN_PX}
                defaultSize={storedPanel}
                onResize={(size) => paneWidth.write(size.inPixels)}
              >
                <SidePanelFrame>
                  <SidePanelBody tab={search.tab} />
                </SidePanelFrame>
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <Pane keyed={keyed} />
          )}
        </div>
      </div>
      <SidePanelDrawer
        open={layout.sidePanel === "drawer"}
        tab={search.tab}
        tabs={panelTabs}
        onTabChange={setTab}
        onClose={() => setTab(undefined)}
      />
    </div>
  );
};
