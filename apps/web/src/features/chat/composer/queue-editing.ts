/** The queue row being edited per thread (`ArrowUp` in an empty field, §8.4). */
import { Store } from "@tanstack/react-store";

export const queueEditing = new Store<Record<string, string | null>>({});

export const setQueueEditing = (
  threadId: string,
  entryId: string | null
): void =>
  queueEditing.setState((state) => ({ ...state, [threadId]: entryId }));
