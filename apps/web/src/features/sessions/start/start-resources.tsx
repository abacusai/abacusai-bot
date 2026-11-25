import {
  draftConversationKey,
  draftConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import { useSelector } from "@tanstack/react-store";
import {
  lazy,
  useEffect,
  useEffectEvent,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import type { BrowserSurface } from "#renderer/components/browser-surface";
import type { TerminalAction } from "#renderer/components/terminal/keys";

const BrowserTab = lazy(() =>
  import("#platform/browser-tab").then((m) => ({ default: m.BrowserTab }))
);
const TerminalTab = lazy(() =>
  import("../terminal/terminal-tab").then((m) => ({ default: m.TerminalTab }))
);
import { useWorkspace } from "../data/queries";
import { isRelativePath } from "../data/search";
import {
  openTab,
  panelTabsStore,
  updateTabs,
  EMPTY_TABS,
} from "../dock/panel-tabs-store";
import { SessionDock, type SessionDockProps } from "../dock/session-dock";
const SessionFilePreview = lazy(() =>
  import("../files/files-tab").then((m) => ({ default: m.SessionFilePreview }))
);
import { startDraftStore } from "./start-session";

/**
 * A new chat's side panel: the chat's own dock (tab strip, menus, icon row)
 * keyed by the draft, so terminals, pages and previews opened before the
 * first message move into the chat with it (promoteTabs).
 */
export const SessionStartResources = ({
  workspaceId,
  children,
  register,
  presenter,
  blocked,
  dispatch,
  registerHotkeys,
}: {
  workspaceId: string | null;
  dispatch: (id: TerminalAction) => void;
  registerHotkeys: SessionDockProps["registerHotkeys"];
  children: ReactNode;
  register(
    key: string,
    open: (event: { path?: string; url?: string }) => boolean
  ): () => void;
  presenter: ComponentProps<typeof BrowserSurface>["presenter"];
  blocked: ComponentProps<typeof BrowserSurface>["blocked"];
}) => {
  const { t } = useTranslation();
  const draft = useSelector(startDraftStore, (s) => s);
  const id = draft.workspaceId ?? workspaceId;
  const workspace = useWorkspace(id ?? "");
  const key = id ? draftConversationKey(id, draft.id) : null;
  const entries = useSelector(panelTabsStore, (s) =>
    key ? (s[key] ?? EMPTY_TABS) : EMPTY_TABS
  );
  const receive = useEffectEvent((event: { path?: string; url?: string }) => {
    if (!key || !workspace?.path) return false;
    const path = event.path?.startsWith(`${workspace.path}/`)
      ? event.path.slice(workspace.path.length + 1)
      : event.path;
    if (path && !isRelativePath(path)) return false;
    const match = entries.tabs.find((tab) =>
      path ? tab.path === path : tab.url === event.url
    );
    const ref =
      match?.ref ?? `${path ? "preview" : "browser"}:${crypto.randomUUID()}`;
    openTab(key, {
      ref,
      title:
        path?.split("/").at(-1) ?? event.url ?? t("sessions.browser.title"),
      ...(path ? { path } : { url: event.url }),
    });
    updateTabs(key, (s) => ({ ...s, open: true }));
    return true;
  });
  useEffect(
    () => (key ? register(key, (event) => receive(event)) : undefined),
    [key, register]
  );
  if (!id || !key) return <div className="size-full min-h-0">{children}</div>;
  const root = workspace?.path ?? "";
  const row = { workspaceId: id, id: draft.id };
  return (
    <SessionDock
      draft
      row={row}
      chat={children}
      registerHotkeys={registerHotkeys}
      renderTab={(tab, visible, onClose) => {
        const tabId = tab.ref.slice(tab.ref.indexOf(":") + 1);
        if (tab.ref.startsWith("terminal:"))
          return (
            <TerminalTab
              row={row}
              conversation={draftConversationRef(id, draft.id)}
              id={tabId}
              shell={tab.shell}
              visible={visible}
              onClose={onClose}
              dispatch={dispatch}
              onUrl={(url) => {
                openTab(key, {
                  ref: `browser:${crypto.randomUUID()}`,
                  title: url,
                  url,
                });
                updateTabs(key, (s) => ({ ...s, open: true }));
              }}
            />
          );
        if (tab.ref.startsWith("preview:") && tab.path)
          return (
            <SessionFilePreview
              inTab
              root={root}
              scope={key}
              path={tab.path}
              renderLocal={(file) => (
                <BrowserTab
                  row={row}
                  scope={key}
                  id={tabId}
                  root={root}
                  file={file}
                  visible={visible}
                  presenter={presenter}
                  blocked={blocked}
                />
              )}
            />
          );
        return (
          <BrowserTab
            row={row}
            scope={key}
            id={tabId}
            root={root}
            url={tab.url}
            visible={visible}
            presenter={presenter}
            blocked={blocked}
          />
        );
      }}
    />
  );
};
