/**
 * The shell's view of the side panel (spec 01 §7.5, §7.9): which scope the
 * current location belongs to, that scope's strip from `panelStore`, and
 * the one toggle shared by the title-bar button and ⌘⌥B. `?tab=` (and the
 * bots' `?preview=`) is a deep link: consumed into the store, then stripped
 * from the URL, so later navigations within the scope never reset the panel.
 */
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { createContext, useContext, useEffect } from "react";

import { useDb } from "#renderer/data/db";
import {
  panelTabsStore,
  EMPTY_TABS,
  updateTabs,
} from "#renderer/features/sessions/dock/panel-tabs-store";

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

export const useSessionPanelTabs = (key: string | null) =>
  useStore(panelTabsStore, (state) =>
    key ? (state[key] ?? EMPTY_TABS) : EMPTY_TABS
  );

export const usePanel = (area: ShellArea | undefined) => {
  const params = useParams({ strict: false }) as {
    botId?: string;
    sessionId?: string;
  };
  const db = useDb();
  const row = params.sessionId
    ? db.collections.sessions.get(params.sessionId)
    : undefined;
  const sessionKey =
    area === "sessions" && row
      ? sessionConversationKey(row.workspaceId, row.id)
      : null;
  const sessionTabs = useSessionPanelTabs(sessionKey);
  const key = panelScopeKey(area, params.botId);
  const scope = usePanelScope(key);
  const search = useSearch({ strict: false }) as {
    tab?: string;
    preview?: string;
    view?: "full" | "split";
  };
  const navigate = useNavigate();
  const deepTab = typeof search.tab === "string" ? search.tab : undefined;
  const deepPreview =
    typeof search.preview === "string" ? search.preview : undefined;
  const sessions = area === "sessions";
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
    sessionOpen:
      sessions &&
      (deepTab != null
        ? deepTab !== "chat" ||
          (search.view === "full" && sessionTabs.open === true)
        : sessionTabs.open === true),
    toggle: () => {
      if (sessions) {
        if (!sessionKey) return;
        const current = panelTabsStore.state[sessionKey] ?? EMPTY_TABS;
        const tab = (
          deepTab != null
            ? deepTab !== "chat" || (search.view === "full" && current.open)
            : current.open
        )
          ? undefined
          : (current.last ?? "changes");
        updateTabs(sessionKey, (previous) => ({
          ...previous,
          open: tab != null,
          last: tab ?? previous.last,
        }));
        void navigate({
          from: "/sessions/$sessionId",
          to: "/sessions/$sessionId",
          params: { sessionId: row!.id },
          search: (previous) => ({
            ...previous,
            tab,
          }),
          replace: true,
        });
        return;
      }
      if (key != null && params.botId && params.botId !== "new")
        togglePanel(key, area);
    },
  };
};
