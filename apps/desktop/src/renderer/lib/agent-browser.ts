import {
  AGENT_BROWSER_RESOURCE_ID,
  type ConversationKey,
} from "#shared/conversation-scope";

import i18n from "../i18n";
import {
  browserResourceStore,
  selectBrowserResourceScope,
} from "../stores/browser-resource-store";
import { useWorkspaceStore } from "../stores/code-store";
import {
  rightPanelActions,
  rightPanelStore,
} from "../stores/right-panel-react";
import {
  createResourceRightPanelDescriptor,
  selectRightPanelScope,
} from "../stores/right-panel-store";

/** The right-panel tab that shows the agent's own browser for a chat. */
export const agentBrowserDescriptorId = `browser:${AGENT_BROWSER_RESOURCE_ID}`;

/** Chats whose agent browser has been put on screen at least once. */
const revealed = new Set<ConversationKey>();

/** A fresh browser for the chat: the next reveal is a first one again. */
export const forgetAgentBrowserReveal = (scope: ConversationKey): void => {
  revealed.delete(scope);
};

/**
 * Put the agent's browser for `scope` on screen. Returns false when the chat
 * has none or the mode says to leave things alone: `first-time` surfaces a
 * background-driven browser once and respects a tab the user then closed;
 * `if-no-tab` (the Browser button) reuses the agent's tab over a blank page.
 */
export const revealAgentBrowser = (
  scope: ConversationKey,
  mode: "always" | "first-time" | "if-no-tab" = "always"
): boolean => {
  const resource = selectBrowserResourceScope(browserResourceStore.state, scope)
    .resources[AGENT_BROWSER_RESOURCE_ID];
  if (resource == null) return false;

  const hasTab = selectRightPanelScope(
    rightPanelStore.state,
    scope
  ).descriptors.some(({ id }) => id === agentBrowserDescriptorId);
  if (mode === "if-no-tab" && hasTab) return false;
  if (mode === "first-time" && (hasTab || revealed.has(scope))) return false;

  revealed.add(scope);
  useWorkspaceStore.getState().setRightPanelVisible(true);
  rightPanelActions.focus(
    scope,
    createResourceRightPanelDescriptor({
      id: agentBrowserDescriptorId,
      resourceType: "browser",
      resourceKey: AGENT_BROWSER_RESOURCE_ID,
      // A descriptor without a string title is dropped; fall back to English.
      title: i18n.t("workspace.rightPanel.browser") ?? "Browser",
    })
  );
  return true;
};
