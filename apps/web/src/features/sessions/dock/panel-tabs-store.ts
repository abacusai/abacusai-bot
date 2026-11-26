import type { TerminalSessionSnapshot } from "@abacus-ai/contract/contracts";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import { Store } from "@tanstack/react-store";

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
  closed?: PanelTab[];
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
/**
 * A new chat's full view (a chat keeps it in its URL; a new chat has none).
 * Opening a new chat again (Ctrl+N reuses an empty one) shows its composer:
 * openStartDraft sets it back to split.
 */
export const draftViewStore = new Store<"full" | "split">("split");
/**
 * Each chat's terminal tabs, kept across app restarts (the tabs above live
 * only as long as the window). The shells die with the app; their tabs come
 * back with fresh ones in the chat's folder (`reconcileTerminals`).
 */
type SavedTerminals = Record<
  string,
  { tabs: Pick<PanelTab, "ref" | "title" | "shell">[]; shown: string | null }
>;
const savedTerminals = persistedStore<SavedTerminals>(
  "abacusai-bot:abacus.sessions.terminals",
  () => ({}),
  { durable: true, bind: false }
);
const isTerminal = (ref: string | null | undefined) =>
  !!ref?.startsWith("terminal:");
/** Chats whose terminals this window has already reconciled with main. */
const reconciled = new Set<string>();
// Mirrored from the chats this window has reconciled (so what was saved is
// revived before anything here can overwrite it); a chat it never opened
// keeps what was saved for it. A new chat's draft is not kept.
panelTabsStore.subscribe((state) =>
  savedTerminals.setState((saved) => {
    let next = saved;
    for (const [key, entry] of Object.entries(state)) {
      if (
        !reconciled.has(key) ||
        conversationRefFromKey(key as ConversationKey)?.kind !== "session"
      )
        continue;
      const tabs = entry.tabs
        .filter((tab) => isTerminal(tab.ref))
        .map(({ ref, title, shell }) => ({
          ref,
          title,
          ...(shell ? { shell } : {}),
        }));
      const shown = entry.open && isTerminal(entry.last) ? entry.last : null;
      if (
        JSON.stringify(saved[key] ?? null) ===
        JSON.stringify(tabs.length ? { tabs, shown } : null)
      )
        continue;
      next = { ...next };
      if (tabs.length) next[key] = { tabs, shown };
      else delete next[key];
    }
    return next;
  })
);
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
      if (entry.owners) return;
      // Wherever the tab lives now: a new chat's tab moves to its chat
      // (promoteTabs) while its start is on its way.
      for (const [owner, starts] of pendingTerminalStarts)
        if (starts.get(ref) === entry) {
          starts.delete(ref);
          if (!starts.size) pendingTerminalStarts.delete(owner);
        }
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
/** The tab closing `ref` lands on, without closing it. */
export const nextTab = (key: string, ref: string): string | undefined =>
  removeRefs(panelTabsStore.state[key] ?? EMPTY_TABS, [ref]).last ?? undefined;
/**
 * Terminals whose shell exited in this window: main keeps no shell for them,
 * but the tab stays (its output, Restart) until the user closes it.
 */
const exitedTerminals = new Set<string>();
export const markTerminalExited = (
  key: string,
  ref: string,
  exited: boolean
): void => {
  if (exited) exitedTerminals.add(`${key} ${ref}`);
  else exitedTerminals.delete(`${key} ${ref}`);
};
/** The shell a terminal tab started with, kept on the tab once known. */
export const rememberTerminalShell = (
  key: string,
  ref: string,
  shell: NonNullable<PanelTab["shell"]>
): void =>
  updateTabs(key, (s) =>
    s.tabs.some((tab) => tab.ref === ref && tab.shell !== shell)
      ? {
          ...s,
          tabs: s.tabs.map((tab) =>
            tab.ref === ref ? { ...tab, shell } : tab
          ),
        }
      : s
  );
/** A terminal's tab name, as its tab shows it (kept across restarts too). */
export const terminalTabTitle = (
  key: string,
  terminalId: string
): string | undefined => {
  const ref = `terminal:${terminalId}`;
  return (
    panelTabsStore.state[key]?.tabs.find((tab) => tab.ref === ref)?.title ??
    savedTerminals.state[key]?.tabs.find((tab) => tab.ref === ref)?.title
  );
};
export const terminalExited = (key: string, ref: string): boolean =>
  exitedTerminals.has(`${key} ${ref}`);
export const closeTab = (key: string, ref: string): string | undefined => {
  exitedTerminals.delete(`${key} ${ref}`);
  const pending = pendingTerminalStarts.get(key);
  pending?.delete(ref);
  if (pending && !pending.size) pendingTerminalStarts.delete(key);
  let next: string | undefined;
  updateTabs(key, (s) => {
    const repaired = removeRefs(s, [ref]);
    next = repaired.last ?? undefined;
    const closed = s.tabs.find((tab) => tab.ref === ref);
    return closed
      ? { ...repaired, closed: [...(s.closed ?? []).slice(-19), closed] }
      : repaired;
  });
  return next;
};
/**
 * A new terminal's title, told apart from the chat's others: "Terminal",
 * then "Terminal 2", "Terminal 3", the lowest number not in use.
 */
export const terminalTitle = (key: string, base: string): string => {
  const used = new Set(
    (panelTabsStore.state[key]?.tabs ?? [])
      .filter((tab) => tab.ref.startsWith("terminal:"))
      .map((tab) => tab.title)
  );
  let n = 1;
  while (used.has(n === 1 ? base : `${base} ${n}`)) n++;
  return n === 1 ? base : `${base} ${n}`;
};
export const reconcileTerminals = (
  key: string,
  states: TerminalSessionSnapshot[],
  title = "Terminal"
): void => {
  // First word from main in this window: saved terminal tabs it has no
  // shell for (the app restarted) come back, each starting a fresh shell in
  // the chat's folder when it mounts.
  if (!reconciled.has(key)) {
    reconciled.add(key);
    const saved = savedTerminals.state[key];
    const current = panelTabsStore.state[key]?.tabs ?? [];
    const revived = (saved?.tabs ?? []).filter(
      (tab) =>
        !current.some((open) => open.ref === tab.ref) &&
        !states.some((state) => `terminal:${state.terminalId}` === tab.ref)
    );
    for (const tab of revived) openTerminalTab(key, tab);
    if (revived.length && saved?.shown)
      updateTabs(key, (s) => ({ ...s, open: true, last: saved.shown }));
  }
  updateTabs(key, (s) =>
    removeRefs(
      s,
      s.tabs
        .filter(
          (tab) =>
            tab.ref.startsWith("terminal:") &&
            !pendingTerminalStarts.get(key)?.has(tab.ref) &&
            !exitedTerminals.has(`${key} ${tab.ref}`) &&
            !states.some((state) => `terminal:${state.terminalId}` === tab.ref)
        )
        .map((tab) => tab.ref)
    )
  );
  const previousLast = panelTabsStore.state[key]?.last;
  // A tab already open keeps its title (numbered, or renamed).
  for (const state of states)
    if (
      !panelTabsStore.state[key]?.tabs.some(
        (tab) => tab.ref === `terminal:${state.terminalId}`
      )
    )
      openTab(key, {
        ref: `terminal:${state.terminalId}`,
        title: terminalTitle(key, title),
      });
  updateTabs(key, (s) => ({ ...s, last: previousLast ?? s.last }));
};
/**
 * A new chat's tabs become its chat's, with what is known of their shells
 * (one still starting, one exited): main keeps them as the chat's from its
 * promotion on, so the chat's tabs and shells match one to one.
 */
export const promoteTabs = (from: string, to: string): void => {
  const pending = pendingTerminalStarts.get(from);
  if (pending) {
    pendingTerminalStarts.delete(from);
    const target = pendingTerminalStarts.get(to) ?? new Map();
    for (const [ref, entry] of pending) target.set(ref, entry);
    pendingTerminalStarts.set(to, target);
  }
  for (const mark of exitedTerminals)
    if (mark.startsWith(`${from} `)) {
      exitedTerminals.delete(mark);
      exitedTerminals.add(`${to} ${mark.slice(from.length + 1)}`);
    }
  panelTabsStore.setState((s) => {
    const next = { ...s, [to]: s[from] ?? s[to] ?? EMPTY_TABS };
    delete next[from];
    return next;
  });
};

export const reopenTab = (key: string): string | null => {
  const tab = panelTabsStore.state[key]?.closed?.at(-1);
  if (!tab) return null;
  updateTabs(key, (state) => ({
    ...state,
    closed: state.closed?.slice(0, -1),
    open: true,
  }));
  const kind = tab.ref.split(":")[0];
  const next = {
    ...tab,
    ref:
      kind === "terminal" || kind === "browser"
        ? `${kind}:${crypto.randomUUID()}`
        : tab.ref,
  };
  (kind === "terminal" ? openTerminalTab : openTab)(key, next);
  return next.ref;
};

/**
 * Whether a dock tab actually drew its page: a native view's present
 * succeeded, or an in-page viewer mounted while visible. `present_deliverable`
 * is told "shown" only from here, never because a tab merely opened.
 */
export type TabDraw = "drawn" | "failed" | "hidden";

const tabId = (key: string, ref: string) => JSON.stringify([key, ref]);
const drawn = new Set<string>();
const waiting = new Map<string, (drawn: boolean) => void>();

export const reportTabDraw = (key: string, ref: string, draw: TabDraw) => {
  const id = tabId(key, ref);
  if (draw === "drawn") drawn.add(id);
  else drawn.delete(id);
  // Hidden is not an answer: a tab just opened is hidden until selected.
  if (draw === "hidden") return;
  const resolve = waiting.get(id);
  waiting.delete(id);
  resolve?.(draw === "drawn");
};

/** Resolves once the tab drew (true) or failed to (false); at once when it is on screen already. */
export const awaitTabDraw = (key: string, ref: string): Promise<boolean> => {
  const id = tabId(key, ref);
  if (drawn.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    // A newer wait for the same tab supersedes this one.
    waiting.get(id)?.(false);
    waiting.set(id, resolve);
  });
};
