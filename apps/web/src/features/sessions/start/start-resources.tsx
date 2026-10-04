import { draftConversationKey } from "@abacus-ai/contract/conversation-scope";
import { useSelector } from "@tanstack/react-store";
import {
  lazy,
  Suspense,
  useEffect,
  useEffectEvent,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import type { BrowserSurface } from "#renderer/components/browser-surface";
import { Button } from "#renderer/ui/button";
import { Tabs, TabsList, TabsTrigger } from "#renderer/ui/tabs";

const BrowserTab = lazy(() =>
  import("#platform/browser-tab").then((m) => ({ default: m.BrowserTab }))
);
import { useWorkspace } from "../data/queries";
import { isRelativePath } from "../data/search";
import {
  openTab,
  closeTab,
  panelTabsStore,
  EMPTY_TABS,
} from "../dock/panel-tabs-store";
const SessionFilePreview = lazy(() =>
  import("../files/files-tab").then((m) => ({ default: m.SessionFilePreview }))
);
import { startDraftStore } from "./start-session";

export const SessionStartResources = ({
  workspaceId,
  children,
  register,
  presenter,
  blocked,
}: {
  workspaceId: string | null;
  children: ReactNode;
  register(
    key: string,
    open: (event: { path?: string; url?: string }) => void
  ): () => void;
  presenter: ComponentProps<typeof BrowserSurface>["presenter"];
  blocked: ComponentProps<typeof BrowserSurface>["blocked"];
}) => {
  const { t } = useTranslation();
  const draft = useSelector(startDraftStore, (s) => s);
  const id = draft.workspaceId ?? workspaceId;
  const workspace = useWorkspace(id ?? "");
  const key = id ? draftConversationKey(id) : null;
  const entries = useSelector(panelTabsStore, (s) =>
    key ? (s[key] ?? EMPTY_TABS) : EMPTY_TABS
  );
  const [selected, setSelected] = useState<string | null>(null);
  const receive = useEffectEvent((event: { path?: string; url?: string }) => {
    if (!key || !workspace?.path) return;
    const path = event.path?.startsWith(`${workspace.path}/`)
      ? event.path.slice(workspace.path.length + 1)
      : event.path;
    if (path && !isRelativePath(path)) return;
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
    setSelected(ref);
  });
  useEffect(
    () => (key ? register(key, (event) => receive(event)) : undefined),
    [key, register]
  );
  const active =
    entries.tabs.find((tab) => tab.ref === selected) ?? entries.tabs.at(-1);
  return (
    <div className="flex size-full min-h-0 flex-wrap">
      <div className="min-w-0 flex-1">{children}</div>
      {active && key && workspace?.path ? (
        <Suspense fallback={null}>
          <aside
            className="flex min-h-0 w-[min(480px,100%)] flex-col border-l"
            aria-label={t("sessions.files.preview")}
          >
            <Tabs
              value={active.ref}
              onValueChange={(value) => {
                if (typeof value === "string") setSelected(value);
              }}
            >
              <TabsList className="w-full justify-start overflow-auto">
                {entries.tabs.map((tab) => (
                  <TabsTrigger key={tab.ref} value={tab.ref}>
                    {tab.title}
                    {entries.tabs.filter((t) => t.title === tab.title).length >
                    1
                      ? ` (${entries.tabs.filter((t) => t.title === tab.title).findIndex((t) => t.ref === tab.ref) + 1})`
                      : ""}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => closeTab(key, active.ref)}
            >
              {t("sessions.dock.closeTab", { name: active.title })}
            </Button>
            <div className="min-h-0 flex-1">
              {active.path ? (
                <SessionFilePreview
                  root={workspace.path}
                  path={active.path}
                  renderLocal={(file) => (
                    <BrowserTab
                      row={{ workspaceId: workspace.id, id: draft.id }}
                      scope={key}
                      id={active.ref.slice(active.ref.indexOf(":") + 1)}
                      root={workspace.path!}
                      file={file}
                      visible
                      presenter={presenter}
                      blocked={blocked}
                    />
                  )}
                />
              ) : (
                <BrowserTab
                  row={{ workspaceId: workspace.id, id: draft.id }}
                  scope={key}
                  id={active.ref.slice(active.ref.indexOf(":") + 1)}
                  root={workspace.path}
                  url={active.url}
                  visible
                  presenter={presenter}
                  blocked={blocked}
                />
              )}
            </div>
          </aside>
        </Suspense>
      ) : null}
    </div>
  );
};
