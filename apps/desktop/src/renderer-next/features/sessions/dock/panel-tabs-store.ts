import { Store } from "@tanstack/react-store";

import type { TerminalSessionSnapshot } from "#shared/contracts";

import type { DockNode } from "./dock-store";
export interface PanelTab {
  ref: string;
  title: string;
  openedAt: number;
  path?: string;
  url?: string;
}
export interface PanelTabs {
  tabs: PanelTab[];
  last: string | null;
  tree?: DockNode;
}
const KEY = "abacus.sessions.tabs";
const restore = (): Record<string, PanelTabs> => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
export const panelTabsStore = new Store<Record<string, PanelTabs>>(restore());
panelTabsStore.subscribe((s) => {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
});
export const EMPTY_TABS: PanelTabs = { tabs: [], last: null };
export const updateTabs = (
  key: string,
  fn: (tabs: PanelTabs) => PanelTabs
): void => {
  panelTabsStore.setState((s) => ({ ...s, [key]: fn(s[key] ?? EMPTY_TABS) }));
};
export const openTab = (key: string, tab: Omit<PanelTab, "openedAt">): void =>
  updateTabs(key, (s) => {
    const exists = s.tabs.find((t) => t.ref === tab.ref);
    let tabs = exists ? s.tabs : [...s.tabs, { ...tab, openedAt: Date.now() }];
    const previews = tabs.filter((t) => t.ref.startsWith("preview:"));
    if (previews.length > 50)
      tabs = tabs.filter((t) => t.ref !== previews[0]?.ref);
    return { ...s, tabs, last: tab.ref };
  });
export const closeTab = (key: string, ref: string): string | undefined => {
  let next: string | undefined;
  updateTabs(key, (s) => {
    const i = s.tabs.findIndex((t) => t.ref === ref);
    next = s.tabs[i + 1]?.ref ?? s.tabs[i - 1]?.ref;
    return {
      ...s,
      tabs: s.tabs.filter((t) => t.ref !== ref),
      last: next ?? null,
    };
  });
  return next;
};
export const reconcileTerminals = (
  key: string,
  states: TerminalSessionSnapshot[]
): void => {
  updateTabs(key, (s) => ({
    ...s,
    tabs: s.tabs.filter(
      (t) =>
        !t.ref.startsWith("terminal:") ||
        states.some((v) => `terminal:${v.terminalId}` === t.ref)
    ),
  }));
  for (const state of states)
    openTab(key, {
      ref: `terminal:${state.terminalId}`,
      title: state.terminalId,
    });
};
export const promoteTabs = (from: string, to: string): void =>
  panelTabsStore.setState((s) => {
    const next = { ...s, [to]: s[from] ?? s[to] ?? EMPTY_TABS };
    delete next[from];
    return next;
  });
