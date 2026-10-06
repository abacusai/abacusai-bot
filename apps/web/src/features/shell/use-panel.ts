/**
 * The shell's view of the side panel (spec 01 §7.5, §7.9): which scope the
 * current location belongs to, that scope's strip from `panelStore`, and
 * the one toggle shared by the title-bar button and ⌘⌥B. `?tab=` (and the
 * bots' `?preview=`) is a deep link: consumed into the store, then stripped
 * from the URL, so later navigations within the scope never reset the panel.
 */
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { createContext, useContext, useEffect } from "react";

import type { ShellArea } from "./layout";
import {
  EMPTY_PANEL,
  isPanelTabKind,
  openPanelTab,
  panelScopeKey,
  panelStore,
  togglePanel,
  type PanelScope,
  type PanelTab,
} from "./panel-store";
import { rememberSessionTab, shellStore } from "./shell-store";

/** The scope key the shell resolved for the current location. */
export const PanelScopeContext = createContext<string | null>(null);

export const usePanelScopeKey = (): string | null =>
  useContext(PanelScopeContext);

export const usePanelScope = (key: string | null): PanelScope =>
  useStore(panelStore, (state) =>
    key == null ? EMPTY_PANEL : (state[key] ?? EMPTY_PANEL)
  );

export const activeTabOf = (scope: PanelScope): PanelTab | undefined =>
  scope.tabs.find((tab) => tab.id === scope.active);

export const usePanel = (area: ShellArea | undefined) => {
  const params = useParams({ strict: false }) as { botId?: string };
  const key = panelScopeKey(area, params.botId);
  const scope = usePanelScope(key);
  const search = useSearch({ strict: false }) as {
    tab?: string;
    preview?: string;
  };
  const navigate = useNavigate();
  const deepTab = typeof search.tab === "string" ? search.tab : undefined;
  const deepPreview =
    typeof search.preview === "string" ? search.preview : undefined;
  // The sessions dock keeps `?tab=` as its own active tab; the toggle
  // remembers it so ⌘⌥B reopens the same one.
  const sessions = area === "sessions";
  useEffect(() => {
    if (sessions && deepTab != null) rememberSessionTab(deepTab as never);
  }, [sessions, deepTab]);
  useEffect(() => {
    if (key == null || sessions) return;
    if (deepTab == null && deepPreview == null) return;
    if (deepPreview != null)
      openPanelTab(key, { kind: "files", path: deepPreview });
    else if (isPanelTabKind(deepTab)) openPanelTab(key, { kind: deepTab });
    void navigate({
      to: ".",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        tab: undefined,
        preview: undefined,
      }),
      replace: true,
    });
  }, [key, sessions, deepTab, deepPreview, navigate]);
  return {
    key,
    scope,
    open: scope.open && scope.tabs.length > 0,
    active: activeTabOf(scope),
    toggle: () => {
      if (sessions) {
        void navigate({
          to: ".",
          search: (previous: Record<string, unknown>) => ({
            ...previous,
            tab:
              deepTab != null
                ? undefined
                : (shellStore.state.lastSessionTab ?? "changes"),
          }),
          replace: true,
        });
        return;
      }
      if (key != null) togglePanel(key, area);
    },
  };
};
