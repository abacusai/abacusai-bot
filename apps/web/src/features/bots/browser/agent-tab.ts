/**
 * The bot's own browser in its side panel. The agent drives one page per
 * chat (main's `agent-browser` resource); its navigations show that page,
 * not a tab of its own each, or the user would watch and sign in on a copy
 * while the agent worked on another page. Pages the user opens keep their tabs.
 */
import { AGENT_BROWSER_RESOURCE_ID } from "@abacus-ai/contract/conversation-scope";

import {
  openPanelTabWithId,
  type PanelTab,
} from "#renderer/lib/side-panel/store";

/** The panel tab bound to the agent's browser. */
export const AGENT_PANEL_TAB = `browser:${AGENT_BROWSER_RESOURCE_ID}`;

/** Show the agent's browser in the bot's panel. */
export const showAgentBrowser = (scopeKey: string, url?: string): void =>
  openPanelTabWithId(scopeKey, {
    id: AGENT_PANEL_TAB,
    kind: "browser",
    ...(url ? { url, title: url } : {}),
  });

/** The runtime resource a panel tab shows: the agent's page for its tab, else the tab's own. */
export const panelTabResource = (tab: PanelTab): string =>
  tab.id === AGENT_PANEL_TAB ? AGENT_BROWSER_RESOURCE_ID : tab.id;
