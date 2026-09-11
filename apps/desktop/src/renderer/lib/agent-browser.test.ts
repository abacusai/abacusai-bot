/**
 * Putting the agent's browser on screen: the one path the materialize
 * event, a chat coming on screen, and the Browser button all share.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AGENT_BROWSER_RESOURCE_ID } from "#shared/conversation-scope";

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const {
  browserResourceActions,
  browserResourceStore,
  createBrowserResourceState,
} = await import("../stores/browser-resource-store");
const { useWorkspaceStore } = await import("../stores/code-store");
const { rightPanelActions, rightPanelStore } =
  await import("../stores/right-panel-react");
const { createRightPanelState, rightPanelScopeKey } =
  await import("../stores/right-panel-store");
const {
  agentBrowserDescriptorId,
  forgetAgentBrowserReveal,
  revealAgentBrowser,
} = await import("./agent-browser");

const scope = rightPanelScopeKey({ workspaceId: "ws", sessionId: "chat" });

const tabs = () =>
  rightPanelStore.state.scopes[scope]?.descriptors.map(({ id }) => id) ?? [];
const activeTab = () => rightPanelStore.state.scopes[scope]?.activeId ?? null;

beforeEach(() => {
  rightPanelStore.setState(() => createRightPanelState());
  browserResourceStore.setState(() => createBrowserResourceState());
  useWorkspaceStore.setState({ isRightPanelVisible: false });
  forgetAgentBrowserReveal(scope);
});

const adopt = () =>
  browserResourceActions.adopt(
    scope,
    AGENT_BROWSER_RESOURCE_ID,
    "https://example.com"
  );

describe("revealAgentBrowser", () => {
  it("does nothing for a chat whose agent has no browser", () => {
    expect(revealAgentBrowser(scope)).toBe(false);
    expect(tabs()).toEqual([]);
  });

  it("opens the panel on the agent's browser tab", () => {
    adopt();
    expect(revealAgentBrowser(scope)).toBe(true);
    expect(activeTab()).toBe(agentBrowserDescriptorId);
    expect(useWorkspaceStore.getState().isRightPanelVisible).toBe(true);
  });

  it("surfaces a background browser once, and respects a closed tab", () => {
    adopt();
    expect(revealAgentBrowser(scope, "first-time")).toBe(true);
    rightPanelActions.close(scope, agentBrowserDescriptorId);
    expect(revealAgentBrowser(scope, "first-time")).toBe(false);
    expect(tabs()).toEqual([]);
    // A new browser for the chat is news again.
    forgetAgentBrowserReveal(scope);
    expect(revealAgentBrowser(scope, "first-time")).toBe(true);
  });

  it("stands in for a blank tab only while it has no tab of its own", () => {
    adopt();
    expect(revealAgentBrowser(scope, "if-no-tab")).toBe(true);
    expect(revealAgentBrowser(scope, "if-no-tab")).toBe(false);
    expect(tabs()).toEqual([agentBrowserDescriptorId]);
  });
});
