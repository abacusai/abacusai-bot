import type { Db } from "#next/data/db";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { isRelativePath } from "../data/search";
import { markSessionUnread } from "../data/unread-store";
import { openTab, panelTabsStore } from "../dock/panel-tabs-store";
export const recordBackgroundPreview = (
  db: Db,
  event: { conversationKey?: string; path?: string; url?: string }
) => {
  if (!event.conversationKey) return;
  const ref = conversationRefFromKey(event.conversationKey as ConversationKey);
  if (ref?.kind !== "session") return;
  const row = db.collections.sessions.get(ref.sessionId);
  if (!row) return;
  const root =
    row.worktreePath ?? db.collections.workspaces.get(row.workspaceId)?.path;
  if (!root) return;
  const path = event.path?.startsWith(`${root}/`)
    ? event.path.slice(root.length + 1)
    : event.path;
  if (path && !isRelativePath(path)) return;
  const existing = panelTabsStore.state[event.conversationKey]?.tabs.find(
    (tab) => (path ? tab.path === path : tab.url === event.url)
  );
  const tab =
    existing?.ref ?? `${path ? "preview" : "browser"}:${crypto.randomUUID()}`;
  openTab(event.conversationKey, {
    ref: tab,
    title: path?.split("/").at(-1) ?? event.url ?? "Browser",
    ...(path ? { path } : { url: event.url }),
  });
  markSessionUnread(row.id);
};
