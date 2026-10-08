/**
 * The side panel's tabs and open state, per scope (spec 01 §7.5 amended):
 * the panel is no longer in the URL. Each scope (`bots:<botId>` for a bot,
 * `area:<area>` otherwise) keeps its own strip: which tabs are open, in what
 * order, which is active and whether the panel is showing. A sub-route
 * (the editor, the check-in pop-up), a dialog or a route transition changes
 * none of it, so coming back finds the panel as it was.
 *
 * Several tabs of one kind may be open (two browsers, two files); each has
 * its own id and may carry a title, a URL (browser) or a path (files).
 * `?tab=` stays a deep-link input: the shell opens the kind it names and
 * strips it from the URL.
 */
import { persistedStore } from "#renderer/lib/continuity/registry";
import {
  AREA_PANEL_TABS,
  SIDE_PANEL_TABS,
  type SidePanelTabId,
} from "#renderer/lib/navigation/search";

type ShellArea = keyof typeof AREA_PANEL_TABS;

export type PanelTabKind = SidePanelTabId;

export const isPanelTabKind = (value: unknown): value is PanelTabKind =>
  typeof value === "string" &&
  (SIDE_PANEL_TABS as readonly string[]).includes(value);

/** The kinds "+" offers per area; the first is what a bare open shows. */
export const AREA_PANEL_KINDS: Record<ShellArea, readonly PanelTabKind[]> =
  AREA_PANEL_TABS;

/** Kinds that may be open more than once at a time. */
export const MULTI_INSTANCE_KINDS: ReadonlySet<PanelTabKind> = new Set([
  "browser",
  "files",
  "terminal",
  "thread",
]);

export interface PanelTab {
  id: string;
  kind: PanelTabKind;
  /** A tab's own title (a page, a file); absent: the kind's name. */
  title?: string;
  /** Browser: the page it shows. */
  url?: string;
  /** Files: the open file, absolute. */
  path?: string;
}

export interface PanelScope {
  expanded?: boolean;
  open: boolean;
  tabs: PanelTab[];
  active: string | null;
}

export type PanelState = Record<string, PanelScope>;

export const EMPTY_PANEL: PanelScope = { open: false, tabs: [], active: null };

export const panelStore = persistedStore<PanelState>(
  "abacusai-bot:abacus.shell.panel",
  () => ({}),
  { batchMs: 150 }
);

export const panelScopeKey = (
  area: ShellArea | undefined,
  botId?: string
): string | null =>
  area == null
    ? null
    : area === "bots" && botId != null
      ? `bots:${botId}`
      : `area:${area}`;

export const panelScope = (key: string | null): PanelScope =>
  key == null ? EMPTY_PANEL : (panelStore.state[key] ?? EMPTY_PANEL);

const update = (key: string, fn: (scope: PanelScope) => PanelScope): void =>
  panelStore.setState((state) => {
    const previous = state[key] ?? EMPTY_PANEL;
    const next = fn(previous);
    return next === previous ? state : { ...state, [key]: next };
  });

const newId = (kind: PanelTabKind): string => `${kind}:${crypto.randomUUID()}`;

/**
 * Open (or focus) a tab of `kind` and show the panel. A single-instance kind
 * reuses its tab; a multi-instance kind reuses a tab with the same `url` /
 * `path` when one is given, else adds one. Returns the tab's id.
 */
export const openPanelTab = (
  key: string,
  tab: { kind: PanelTabKind; title?: string; url?: string; path?: string },
  options: { fresh?: boolean } = {}
): string => {
  let id = "";
  update(key, (scope) => {
    const existing = options.fresh
      ? undefined
      : scope.tabs.find((candidate) =>
          candidate.kind !== tab.kind
            ? false
            : !MULTI_INSTANCE_KINDS.has(tab.kind)
              ? true
              : tab.url != null
                ? candidate.url === tab.url
                : tab.path != null
                  ? candidate.path === tab.path
                  : candidate.url == null && candidate.path == null
        );
    if (existing) {
      id = existing.id;
      const merged: PanelTab = { ...existing, ...tab, id: existing.id };
      return {
        ...scope,
        open: true,
        active: id,
        tabs: scope.tabs.map((item) => (item.id === id ? merged : item)),
      };
    }
    id = newId(tab.kind);
    return {
      ...scope,
      open: true,
      active: id,
      tabs: [...scope.tabs, { ...tab, id }],
    };
  });
  return id;
};

export const activatePanelTab = (key: string, id: string): void =>
  update(key, (scope) =>
    scope.active === id && scope.open
      ? scope
      : (id === "chat" && scope.expanded) ||
          scope.tabs.some((tab) => tab.id === id)
        ? { ...scope, open: true, active: id }
        : scope
  );

/** Patch a tab in place (a browser's URL and title, a file's path). */
export const updatePanelTab = (
  key: string,
  id: string,
  patch: Partial<Omit<PanelTab, "id" | "kind">>
): void =>
  update(key, (scope) => {
    const tab = scope.tabs.find((item) => item.id === id);
    if (!tab) return scope;
    const next = { ...tab, ...patch };
    if (
      (Object.keys(patch) as Array<keyof typeof patch>).every(
        (field) => tab[field] === patch[field]
      )
    )
      return scope;
    return {
      ...scope,
      tabs: scope.tabs.map((item) => (item.id === id ? next : item)),
    };
  });

/**
 * Close a tab; the neighbour to its right (else left) becomes active. The
 * last tab closing closes the panel too.
 */
export const closePanelTab = (key: string, id: string): void =>
  update(key, (scope) => {
    const index = scope.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return scope;
    const tabs = scope.tabs.filter((tab) => tab.id !== id);
    const active =
      scope.active !== id
        ? scope.active
        : (tabs[index]?.id ?? tabs[index - 1]?.id ?? null);
    return { ...scope, tabs, active, open: scope.open && tabs.length > 0 };
  });

export const reorderPanelTabs = (key: string, ids: readonly string[]): void =>
  update(key, (scope) => {
    const byId = new Map(scope.tabs.map((tab) => [tab.id, tab]));
    const tabs = ids
      .map((id) => byId.get(id))
      .filter((tab): tab is PanelTab => tab != null);
    if (tabs.length !== scope.tabs.length) return scope;
    if (tabs.every((tab, i) => tab === scope.tabs[i])) return scope;
    return { ...scope, tabs };
  });

/** Cycle the active tab by `direction` (+1 right, −1 left), wrapping. */
export const cyclePanelTab = (key: string, direction: 1 | -1): void =>
  update(key, (scope) => {
    if (scope.tabs.length < 2) return scope;
    const index = scope.tabs.findIndex((tab) => tab.id === scope.active);
    const next =
      scope.tabs[(index + direction + scope.tabs.length) % scope.tabs.length]!;
    return { ...scope, active: next.id };
  });

export const setPanelExpanded = (key: string, expanded: boolean): void =>
  update(key, (scope) => ({
    ...scope,
    expanded,
    active:
      !expanded && scope.active === "chat"
        ? (scope.tabs[0]?.id ?? null)
        : scope.active,
  }));

export const setPanelOpen = (key: string, open: boolean): void =>
  update(key, (scope) => (scope.open === open ? scope : { ...scope, open }));

/**
 * The toggle (title-bar button, ⌘⌥B): an open panel closes; a closed one
 * reopens on its tabs, else on the area's first kind.
 */
export const togglePanel = (key: string, area: ShellArea | undefined): void => {
  const scope = panelScope(key);
  if (scope.open) {
    setPanelOpen(key, false);
    return;
  }
  if (scope.tabs.length > 0) {
    update(key, (current) => ({
      ...current,
      open: true,
      active:
        (current.expanded && current.active === "chat") ||
        current.tabs.some((tab) => tab.id === current.active)
          ? current.active
          : current.tabs[0]!.id,
    }));
    return;
  }
  const first = area == null ? undefined : AREA_PANEL_KINDS[area][0];
  openPanelTab(key, { kind: first ?? "details" });
};

export const resetPanelStore = (): void => panelStore.setState(() => ({}));
