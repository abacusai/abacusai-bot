/**
 * Unread bots (spec 03 §6.7, parity P19): not persisted, driven by the
 * relay's `ai.runFinished` notices (never by table diffs, which coalesce),
 * cleared when any of the bot's chats opens, set by "Mark as unread".
 */
import { Store } from "@tanstack/react-store";
import { useSelector } from "@tanstack/react-store";

export interface UnreadState {
  ids: ReadonlySet<string>;
}

export const createUnreadStore = () => {
  const store = new Store<UnreadState>({ ids: new Set<string>() });
  const set = (botId: string, unread: boolean): void =>
    store.setState((state) => {
      if (state.ids.has(botId) === unread) return state;
      const ids = new Set(state.ids);
      if (unread) ids.add(botId);
      else ids.delete(botId);
      return { ids };
    });
  return {
    store,
    mark: (botId: string) => set(botId, true),
    clear: (botId: string) => set(botId, false),
    has: (botId: string) => store.state.ids.has(botId),
  };
};

export type UnreadStore = ReturnType<typeof createUnreadStore>;

/** The document's store (module scope: one per document). */
export const botsUnreadStore: UnreadStore = createUnreadStore();

export const useBotUnread = (
  botId: string,
  unread: UnreadStore = botsUnreadStore
): boolean => useSelector(unread.store, (state) => state.ids.has(botId));

export const useUnreadIds = (
  unread: UnreadStore = botsUnreadStore
): ReadonlySet<string> => useSelector(unread.store, (state) => state.ids);
