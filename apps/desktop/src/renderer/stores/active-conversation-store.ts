import { createStore, useSelector } from "@tanstack/react-store";

import type { ConversationKey } from "#shared/conversation-scope";

/**
 * The conversation whose panes are on screen, published by the workspace
 * shell (the one place that knows the whole answer). Click-opened previews
 * read it; event-opened ones compare against it before coming forward.
 */
type ActiveConversationState = { key: ConversationKey | null };

export const activeConversationStore = createStore<ActiveConversationState>({
  key: null,
});

export const setActiveConversationKey = (key: ConversationKey | null): void => {
  activeConversationStore.setState((state) =>
    state.key === key ? state : { key }
  );
};

export const getActiveConversationKey = (): ConversationKey | null =>
  activeConversationStore.state.key;

export const useActiveConversationKey = (): ConversationKey | null =>
  useSelector(activeConversationStore, (state) => state.key);
