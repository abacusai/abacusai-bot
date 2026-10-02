import { Store } from "@tanstack/react-store";
export const sessionsUnreadStore = new Store<ReadonlySet<string>>(
  new Set<string>()
);
export const markSessionUnread = (id: string, unread = true): void => {
  sessionsUnreadStore.setState((s) => {
    const next = new Set(s);
    if (unread) next.add(id);
    else next.delete(id);
    return next;
  });
};
export const openSessionOnce = (id: string): void =>
  markSessionUnread(id, false);
