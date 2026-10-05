/**
 * The side panel's one toggle (spec 01 §7.9 "tab ⇄ last tab for the area"),
 * shared by the title-bar button and ⌘⌥B: closing clears `tab`; opening
 * restores the tab last shown in this area, else the area's first.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";

import {
  AREA_PANEL_TABS,
  type SidePanelTabId,
} from "#renderer/lib/navigation/search";

import type { ShellArea } from "./layout";
import { shellStore } from "./shell-store";

/** Where the toggle goes from `current`: undefined closes the panel. */
export const panelToggleTarget = (
  area: ShellArea | undefined,
  current: SidePanelTabId | undefined,
  lastTabByArea: Partial<Record<ShellArea, SidePanelTabId>>
): SidePanelTabId | undefined => {
  if (current != null) return undefined;
  const tabs: readonly SidePanelTabId[] =
    area == null ? [] : AREA_PANEL_TABS[area];
  const last = area == null ? undefined : lastTabByArea[area];
  return last != null && tabs.includes(last) ? last : (tabs[0] ?? "details");
};

export const usePanel = (area: ShellArea | undefined) => {
  const search = useSearch({ strict: false }) as { tab?: SidePanelTabId };
  const navigate = useNavigate();
  const setTab = (tab: SidePanelTabId | undefined): void => {
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({ ...previous, tab }),
      replace: true,
    });
  };
  const toggle = (): void => {
    if (area == null) return;
    setTab(panelToggleTarget(area, search.tab, shellStore.state.lastTabByArea));
  };
  return { tab: search.tab, setTab, toggle };
};
