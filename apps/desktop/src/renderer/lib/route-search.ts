import type { RightTabId } from "../stores/code-store";

/**
 * Legacy search params. The panes they named are routes now (/settings/…), and
 * `beforeLoad` on the workspace route forwards them there; nothing writes these
 * any more, so this is only here to keep an old bookmark or window state from
 * landing on a blank chat.
 */
type MainViewId =
  | "chat"
  | "capabilities"
  | "messaging"
  | "artifacts"
  | "memory"
  | "usage";
type CapabilitiesTabId = "connectors" | "skills" | "tools" | "mcp";

export type WorkspaceSearch = {
  capabilities: CapabilitiesTabId;
  panel?: RightTabId;
  view: MainViewId;
};

const mainViews = new Set<MainViewId>([
  "chat",
  "capabilities",
  "messaging",
  "artifacts",
  "memory",
  "usage",
]);
const rightTabs = new Set<RightTabId>([
  "explorer",
  "agents",
  "preview",
  "device",
]);
const capabilitiesTabs = new Set<CapabilitiesTabId>([
  "connectors",
  "skills",
  "tools",
  "mcp",
]);

export const parseCapabilitiesTab = (value: unknown): CapabilitiesTabId =>
  capabilitiesTabs.has(value as CapabilitiesTabId)
    ? (value as CapabilitiesTabId)
    : "connectors";

export const defaultWorkspaceSearch: WorkspaceSearch = {
  view: "chat",
  capabilities: "connectors",
};

export const parseWorkspaceSearch = (
  search: Record<string, unknown>
): WorkspaceSearch => ({
  view: mainViews.has(search.view as MainViewId)
    ? (search.view as MainViewId)
    : "chat",
  ...(rightTabs.has(search.panel as RightTabId)
    ? { panel: search.panel as RightTabId }
    : {}),
  capabilities: parseCapabilitiesTab(search.capabilities),
});
