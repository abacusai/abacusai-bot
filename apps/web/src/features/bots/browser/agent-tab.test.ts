import { beforeEach, describe, expect, it } from "vitest";

import {
  openPanelTab,
  panelScope,
  resetPanelStore,
} from "#renderer/lib/side-panel/store";

import {
  AGENT_PANEL_TAB,
  panelTabResource,
  showAgentBrowser,
} from "./agent-tab";

const key = "bots:b1";

beforeEach(() => resetPanelStore());

describe("the bot's own browser in its panel", () => {
  it("shows the page the agent drives, one tab however often it navigates", () => {
    // Each agent goto opened a new tab with a page of its own, so the user
    // watched (and signed in on) a copy while the agent drove another page.
    showAgentBrowser(key, "https://a.test/login");
    showAgentBrowser(key, "https://a.test/account");
    const scope = panelScope(key);
    expect(scope.tabs.filter((tab) => tab.kind === "browser")).toHaveLength(1);
    expect(scope.active).toBe(AGENT_PANEL_TAB);
    expect(scope.open).toBe(true);
    expect(panelTabResource(scope.tabs[0]!)).toBe("agent-browser");
  });

  it("keeps the user's own pages as tabs of their own", () => {
    const mine = openPanelTab(key, { kind: "browser", url: "https://b.test" });
    showAgentBrowser(key, "https://a.test");
    const tabs = panelScope(key).tabs;
    expect(tabs.map((tab) => tab.id)).toEqual([mine, AGENT_PANEL_TAB]);
    expect(panelTabResource(tabs[0]!)).toBe(mine);
  });
});
