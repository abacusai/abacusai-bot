import {
  createStore,
  useSelector,
  type UseSelectorOptions,
} from "@tanstack/react-store";

import { browserResourceActions } from "./browser-resource-store";
import { previewActions } from "./preview-store";
import {
  createRightPanelState,
  rightPanelReducer,
  type AgentsAvailability,
  type ConversationKey,
  type DraftConversationKey,
  type RightPanelAction,
  type RightPanelDescriptor,
  type RightPanelScopeKey,
  type RightPanelScopeState,
  type SessionConversationKey,
} from "./right-panel-store";
import { terminalRuntimeActions } from "./terminal-runtime-store";

const EMPTY_SCOPE: RightPanelScopeState = Object.freeze({
  descriptors: Object.freeze([]),
  activeId: null,
  isOpen: false,
  agentsAvailability: Object.freeze({ available: false, reason: null }),
});

export const rightPanelStore = createStore(createRightPanelState());

export const dispatchRightPanel = (action: RightPanelAction): void => {
  rightPanelStore.setState((state) => rightPanelReducer(state, action));
};

export const rightPanelActions = {
  focus: (scope: RightPanelScopeKey, descriptor: RightPanelDescriptor): void =>
    dispatchRightPanel({ type: "focus", scope, descriptor }),

  focusExisting: (scope: RightPanelScopeKey, id: string): void =>
    dispatchRightPanel({ type: "focus-existing", scope, id }),

  close: (scope: RightPanelScopeKey, id: string): void =>
    dispatchRightPanel({ type: "close", scope, id }),

  closeActive: (scope: RightPanelScopeKey): void =>
    dispatchRightPanel({ type: "close-active", scope }),

  hide: (scope: RightPanelScopeKey): void =>
    dispatchRightPanel({ type: "hide", scope }),

  show: (scope: RightPanelScopeKey): void =>
    dispatchRightPanel({ type: "show", scope }),

  reopen: (scope: RightPanelScopeKey): void =>
    dispatchRightPanel({ type: "reopen", scope }),

  setAgentsAvailability: (
    scope: RightPanelScopeKey,
    availability: AgentsAvailability
  ): void =>
    dispatchRightPanel({
      type: "set-agents-availability",
      scope,
      availability,
    }),

  promoteDraft: (
    from: DraftConversationKey,
    to: SessionConversationKey
  ): void => dispatchRightPanel({ type: "promote-draft", from, to }),

  disposeScope: (scope: ConversationKey): void =>
    dispatchRightPanel({ type: "dispose-scope", scope }),

  disposeWorkspace: (workspaceId: string): void =>
    dispatchRightPanel({ type: "dispose-workspace", workspaceId }),
} as const;

/** Coordinates conversation lifecycle across panel descriptors, previews and browser hosts. */
export const conversationScopeActions = {
  promoteDraft: (
    from: DraftConversationKey,
    to: SessionConversationKey
  ): void => {
    browserResourceActions.promoteDraft(from, to);
    rightPanelActions.promoteDraft(from, to);
    terminalRuntimeActions.promoteDraft(from, to);
    previewActions.promoteDraft(from, to);
  },

  disposeScope: (scope: ConversationKey): void => {
    browserResourceActions.disposeScope(scope);
    rightPanelActions.disposeScope(scope);
    terminalRuntimeActions.disposeScope(scope);
    previewActions.disposeScope(scope);
  },

  disposeWorkspace: (workspaceId: string): void => {
    browserResourceActions.disposeWorkspace(workspaceId);
    rightPanelActions.disposeWorkspace(workspaceId);
    terminalRuntimeActions.disposeWorkspace(workspaceId);
    previewActions.disposeWorkspace(workspaceId);
  },
} as const;

export const useRightPanelScopeSelector = <Selected>(
  scope: RightPanelScopeKey,
  selector: (state: RightPanelScopeState) => Selected,
  options?: UseSelectorOptions<Selected>
): Selected =>
  useSelector(
    rightPanelStore,
    (state) => selector(state.scopes[scope] ?? EMPTY_SCOPE),
    options
  );

export const useRightPanelScope = (
  scope: RightPanelScopeKey
): RightPanelScopeState => useRightPanelScopeSelector(scope, (state) => state);
