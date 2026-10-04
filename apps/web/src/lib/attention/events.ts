import type { AttentionEvent, AttentionSummary } from "@abacus-ai/contract/contract";
export interface AttentionState {
  revision: number;
  items: ReadonlyMap<string, AttentionSummary>;
}
export const emptyAttention = (): AttentionState => ({
  revision: -1,
  items: new Map(),
});
/** A reconnect starts with emptyAttention so a restarted relay may reset revisions. */
export const applyAttention = (
  state: AttentionState,
  event: AttentionEvent
): AttentionState => {
  if (event.revision <= state.revision) return state;
  if (event.type === "snapshot")
    return {
      revision: event.revision,
      items: new Map(event.items.map((item) => [item.threadId, item])),
    };
  const items = new Map(state.items);
  if (event.type === "remove") items.delete(event.threadId);
  else items.set(event.item.threadId, event.item);
  return { revision: event.revision, items };
};
