import type { TerminalSessionSnapshot } from "@abacus-ai/contract/contracts";

import { persistedStore } from "#renderer/lib/continuity/registry";

export interface PanelTab {
  ref: string;
  title: string;
  openedAt: number;
  path?: string;
  sessionId?: string;
  shell?: import("@abacus-ai/contract/terminal-shells").TerminalShellId;
  url?: string;
}
export interface PanelTabs {
  open?: boolean;
  order?: string[];
  tabs: PanelTab[];
  last: string | null;
}
export const panelTabsStore = persistedStore<Record<string, PanelTabs>>(
  "abacusai-bot:abacus.sessions.tabs",
  () => ({})
);
export const EMPTY_TABS: PanelTabs = { tabs: [], last: null };
// Kept out of sessionStorage: restored references have no pending start.
const pendingTerminalStarts = new Map<
  string,
  Map<string, { owners: number }>
>();

export const openTerminalTab = (
  key: string,
  tab: Omit<PanelTab, "openedAt">
): void => {
  let pending = pendingTerminalStarts.get(key);
  if (!pending) {
    pending = new Map();
    pendingTerminalStarts.set(key, pending);
  }
  pending.set(tab.ref, { owners: 0 });
  openTab(key, tab);
};

/** Retain a new tab while its adapter and terminal.start are pending. */
export const retainTerminalStart = (key: string, id: string): (() => void) => {
  const pending = pendingTerminalStarts.get(key);
  const ref = `terminal:${id}`;
  const entry = pending?.get(ref);
  if (!entry) return () => {};
  entry.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.owners--;
    queueMicrotask(() => {
      if (entry.owners || pending?.get(ref) !== entry) return;
      pending.delete(ref);
      if (!pending.size) pendingTerminalStarts.delete(key);
    });
  };
};
export const updateTabs = (
  key: string,
  fn: (tabs: PanelTabs) => PanelTabs
): void => {
  panelTabsStore.setState((s) => {
    const previous = s[key] ?? EMPTY_TABS;
    const next = fn(previous);
    return next === previous ? s : { ...s, [key]: next };
  });
};
const removeRefs = (s: PanelTabs, refs: string[]): PanelTabs => {
  const tabs = s.tabs.filter((tab) => !refs.includes(tab.ref));
  const index = s.tabs.findIndex((tab) => tab.ref === s.last);
  const next =
    s.tabs.slice(index + 1).find((tab) => !refs.includes(tab.ref)) ??
    s.tabs
      .slice(0, index)
      .reverse()
      .find((tab) => !refs.includes(tab.ref));
  return {
    ...s,
    tabs,
    last: tabs.some((tab) => tab.ref === s.last)
      ? s.last
      : (next?.ref ?? tabs[0]?.ref ?? null),
  };
};
export const focusTab = (key: string, ref: string) =>
  updateTabs(key, (state) =>
    state.last === ref || !state.tabs.some((tab) => tab.ref === ref)
      ? state
      : { ...state, last: ref }
  );
export const openTab = (key: string, tab: Omit<PanelTab, "openedAt">): void =>
  updateTabs(key, (s) => {
    const exists = s.tabs.find((t) => t.ref === tab.ref);
    let tabs = exists
      ? s.tabs.map((t) => (t.ref === tab.ref ? { ...t, ...tab } : t))
      : [...s.tabs, { ...tab, openedAt: Date.now() }];
    const previews = tabs.filter((t) => t.ref.startsWith("preview:"));
    const evicted =
      previews.length > 50
        ? previews.slice(0, previews.length - 50).map((tab) => tab.ref)
        : [];
    const repaired = removeRefs({ ...s, tabs }, evicted);
    tabs = repaired.tabs;
    return { ...s, tabs, last: tab.ref };
  });
export const updateTab = (
  key: string,
  ref: string,
  patch: Partial<Pick<PanelTab, "url" | "title" | "path">>
): void =>
  updateTabs(key, (s) => {
    const tab = s.tabs.find((tab) => tab.ref === ref);
    if (
      !tab ||
      Object.entries(patch).every(
        ([name, value]) => tab[name as keyof typeof patch] === value
      )
    )
      return s;
    return {
      ...s,
      tabs: s.tabs.map((tab) => (tab.ref === ref ? { ...tab, ...patch } : tab)),
    };
  });
export const closeTab = (key: string, ref: string): string | undefined => {
  const pending = pendingTerminalStarts.get(key);
  pending?.delete(ref);
  if (pending && !pending.size) pendingTerminalStarts.delete(key);
  let next: string | undefined;
  updateTabs(key, (s) => {
    const repaired = removeRefs(s, [ref]);
    next = repaired.last ?? undefined;
    return repaired;
  });
  return next;
};
export const reconcileTerminals = (
  key: string,
  states: TerminalSessionSnapshot[],
  title = "Terminal"
): void => {
  updateTabs(key, (s) =>
    removeRefs(
      s,
      s.tabs
        .filter(
          (tab) =>
            tab.ref.startsWith("terminal:") &&
            !pendingTerminalStarts.get(key)?.has(tab.ref) &&
            !states.some((state) => `terminal:${state.terminalId}` === tab.ref)
        )
        .map((tab) => tab.ref)
    )
  );
  const previousLast = panelTabsStore.state[key]?.last;
  for (const state of states)
    openTab(key, {
      ref: `terminal:${state.terminalId}`,
      title,
    });
  updateTabs(key, (s) => ({ ...s, last: previousLast ?? s.last }));
};
export const promoteTabs = (from: string, to: string): void =>
  panelTabsStore.setState((s) => {
    const next = { ...s, [to]: s[from] ?? s[to] ?? EMPTY_TABS };
    delete next[from];
    return next;
  });
