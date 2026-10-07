import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  terminalShellsForPlatform,
  type TerminalShellId,
} from "@abacus-ai/contract/terminal-shells";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import {
  Plus,
  Maximize,
  Minimize,
  Terminal,
  Globe,
  Folder,
  GitCompare,
  Bot,
  Monitor,
} from "lucide-react";
import {
  ViewTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  Suspense,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { PaneBoundary } from "#renderer/components/page-state";
import {
  PanelWorkspace,
  PANEL_DRAG_TYPE,
  moveDockTab,
} from "#renderer/components/panel-workspace";
import { followNotices } from "#renderer/data/queries/notices";
import { TopBar } from "#renderer/features/shell/top-bar";
import { TopBarPanelSlot } from "#renderer/features/shell/top-bar-slots";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import type { PanelTabKind } from "#renderer/lib/side-panel/store";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { Skeleton } from "#renderer/ui/skeleton";

import { useSessionsTransport } from "../data/queries";
import {
  getTerminalView,
  disposeTerminalView,
} from "../terminal/terminal-registry";
import {
  panelTabsStore,
  EMPTY_TABS,
  openTab,
  openTerminalTab,
  closeTab,
  reopenTab,
  reconcileTerminals,
  updateTabs,
  focusTab,
  type PanelTab,
} from "./panel-tabs-store";
export interface SessionDockProps {
  row: SessionRow;
  chat: ReactNode;
  renderTab: (
    tab: PanelTab,
    visible: boolean,
    onClose: () => void
  ) => ReactNode;
  registerHotkeys: (
    next: () => void,
    previous: () => void,
    close: () => void,
    newTerminal: () => void
  ) => ReactNode;
}
/**
 * A tab whose chunk is still loading. Its own boundary, so the dock and its
 * panes keep their layout instead of the whole dock suspending.
 */
const TabPending = () => {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      aria-label={t("common.loading")}
      data-slot="dock-tab-pending"
      className="flex size-full min-w-0 flex-col gap-2 p-3"
    >
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
};
const terminalId = () => `terminal:terminal-${crypto.randomUUID()}`;
export const SessionDock = ({
  row,
  chat,
  renderTab,
  registerHotkeys,
}: SessionDockProps) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate({ from: "/sessions/$sessionId" });
  const key = sessionConversationKey(row.workspaceId, row.id);
  const search = useSearch({ from: "/_shell/(sessions)/sessions/$sessionId" });
  const entries = useSelector(panelTabsStore, (s) => s[key] ?? EMPTY_TABS);
  const [terminalSnapshot, setTerminalSnapshot] = useState<string | null>(null);
  const dockApi = useRef<import("dockview-react").DockviewApi | null>(null);
  const device = useQuery(
    transport.orpc.devices.status.queryOptions({
      input: {},
      enabled: IS_ELECTRON,
    })
  );
  const shells = useQuery(
    transport.orpc.terminal.shell.get.queryOptions({ input: {} })
  );
  const active =
    search.tab ?? (entries.open ? (entries.last ?? undefined) : undefined);
  const expanded = search.view === "full" && entries.open === true;
  const split = !expanded;
  useEffect(() => {
    if (active && active !== "chat") focusTab(key, active);
  }, [key, active, entries.tabs]);
  useEffect(() => {
    if (search.tab && search.tab !== "chat")
      updateTabs(key, (s) => ({ ...s, open: true }));
  }, [key, search.tab]);
  const select = (tab: string | undefined) => {
    updateTabs(key, (s) => ({
      ...s,
      open: tab != null && (expanded || tab !== "chat"),
      last: tab && tab !== "chat" ? tab : s.last,
    }));
    void navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: row.id },
      search: (previous) => ({ ...previous, tab }),
      replace: true,
      transition: "none",
    });
  };
  const close = (ref: string) => {
    if (ref === "chat") return;
    if (ref.startsWith("terminal:")) {
      const id = ref.slice(9);
      void getTerminalView(`${key}:${id}`)
        .then(async (view) => {
          if (view.generation !== null)
            await transport.client.terminal.hide({
              conversationKey: key,
              terminalId: id,
              generation: view.generation,
              close: true,
            });
          disposeTerminalView(`${key}:${id}`);
        })
        .catch(() => {});
    }
    if (ref.startsWith("browser:")) {
      if (IS_ELECTRON)
        void transport.client.browser.runtime
          .materialize({ conversationKey: key, resourceId: ref.slice(8) })
          .then((state) => transport.client.browser.runtime.close(state.lease))
          .catch(() => {});
    }
    const next = closeTab(key, ref);
    if (active === ref) select(next);
  };
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.terminal.events({ conversationKey: key }, { signal }),
      (event) => {
        if (event.type === "snapshot") {
          reconcileTerminals(key, event.states, t("sessions.dock.terminal"));
          setTerminalSnapshot(key);
        } else
          openTab(key, {
            ref: `terminal:${event.state.terminalId}`,
            title: t("sessions.dock.terminal"),
          });
      },
      abort.signal
    );
    if (IS_ELECTRON)
      void followNotices(
        transport,
        ({ signal }) =>
          transport.client.browser.events({ conversationKey: key }, { signal }),
        (event) => {
          if (event.type === "runtime-materialized")
            openTab(key, {
              ref: `browser:${event.resourceId}`,
              title: event.url,
              url: event.url,
            });
        },
        abort.signal
      );
    return () => abort.abort();
  }, [transport, key, t]);
  const normalizeSelection = useEffectEvent(select);
  useEffect(() => {
    if (
      active &&
      active !== "chat" &&
      !entries.tabs.some((tab) => tab.ref === active) &&
      (!active.startsWith("terminal:") || terminalSnapshot === key)
    ) {
      if (
        ["files", "changes", "agents", "device"].includes(active) ||
        active.startsWith("browser:")
      )
        openTab(key, {
          ref: active,
          title: active.startsWith("browser:")
            ? t("sessions.dock.browser")
            : t(`sessions.dock.${active}`),
        });
      else normalizeSelection(entries.last ?? undefined);
    }
  }, [active, split, key, entries.last, entries.tabs, t, terminalSnapshot]);
  const cycle = (direction: number) => {
    const refs = [
      ...(expanded ? ["chat"] : []),
      ...entries.tabs.map((t) => t.ref),
    ];
    const index = refs.indexOf(active ?? "");
    select(refs[(index + direction + refs.length) % refs.length]);
  };
  const add = (kind: string, shell?: TerminalShellId) => {
    const ref =
      kind === "terminal"
        ? terminalId()
        : kind === "browser"
          ? `browser:browser-${crypto.randomUUID()}`
          : kind;
    const open = kind === "terminal" ? openTerminalTab : openTab;
    open(key, {
      ref,
      title: t(`sessions.dock.${kind}`),
      ...(shell ? { shell } : {}),
    });
    select(ref);
  };
  const [groups, setGroups] = useState(1);
  const titleTabs = expanded
    ? [...entries.tabs]
    : ["changes", "terminal", "files", "browser"]
        .flatMap((kind) => {
          const tabs = entries.tabs.filter(
            (tab) => tab.ref === kind || tab.ref.startsWith(`${kind}:`)
          );
          return tabs.length
            ? tabs
            : [{ ref: kind, title: t(`sessions.dock.${kind}`), openedAt: 0 }];
        })
        .concat(
          entries.tabs.filter(
            (tab) =>
              !["changes", "terminal", "files", "browser"].includes(
                tab.ref.split(":")[0]!
              )
          )
        );
  if (entries.order)
    titleTabs.sort((a, b) => {
      const position = (ref: string) => {
        const index = entries.order!.indexOf(ref);
        return index < 0 ? entries.order!.length : index;
      };
      return position(a.ref) - position(b.ref);
    });
  const choose = (ref: string) => {
    if (ref === "terminal" || ref === "browser") add(ref);
    else select(ref);
  };
  const rename = (ref: string, title: string) =>
    updateTabs(key, (state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.ref === ref ? { ...tab, title } : tab
      ),
    }));
  const controls = (
    <div className="titlebar-nodrag flex h-(--titlebar-row-h) shrink-0 items-center gap-1 self-start px-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("sessions.dock.add")}
            />
          }
        >
          <Plus />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={12}
          className="titlebar-nodrag scroll-fade-y max-h-[min(var(--available-height),320px)] w-56 max-w-[calc(100vw-24px)]"
        >
          <DropdownMenuGroup>
            {terminalShellsForPlatform(
              (document.documentElement.dataset.platform ??
                "darwin") as NodeJS.Platform
            ).map((shell) => (
              <DropdownMenuItem
                key={shell.id}
                disabled={
                  shells.data?.statuses.find((s) => s.id === shell.id)
                    ?.available === false
                }
                onClick={() =>
                  void transport.client.terminal.shell
                    .set({ shell: shell.id as TerminalShellId })
                    .then(() => add("terminal", shell.id))
                }
              >
                <Terminal />
                <span className="min-w-0 truncate">
                  {t("sessions.terminal.newShell", {
                    shell: t(`terminalShells.${shell.labelKey}.label`),
                  })}
                </span>
              </DropdownMenuItem>
            ))}
            {[
              ...(IS_ELECTRON ? ["browser"] : []),
              "terminal",
              "files",
              "changes",
              "agents",
              ...(IS_ELECTRON && device.data?.enabled ? ["device"] : []),
            ].map((kind) => (
              <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                {kind === "browser" ? (
                  <Globe />
                ) : kind === "files" ? (
                  <Folder />
                ) : kind === "changes" ? (
                  <GitCompare />
                ) : kind === "agents" ? (
                  <Bot />
                ) : kind === "device" ? (
                  <Monitor />
                ) : (
                  <Terminal />
                )}
                <span className="min-w-0 truncate">
                  {t(`sessions.dock.${kind}`)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("sessions.dock.full")}
        aria-pressed={!split}
        onClick={() => {
          void navigate({
            to: "/sessions/$sessionId",
            params: { sessionId: row.id },
            search: (previous) => ({
              ...previous,
              view: expanded ? "split" : "full",
            }),
            replace: true,
            transition: "none",
          });
        }}
      >
        {split ? <Maximize /> : <Minimize />}
      </Button>
    </div>
  );
  return (
    <ViewTransition
      default="none"
      update={{ "session-view": "session-view", default: "none" }}
    >
      <div
        data-slot="session-dock"
        data-view={expanded ? "full" : "split"}
        className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        <TopBarPanelSlot>
          {entries.open && active ? (
            <>
              {(!expanded || groups === 1) && (
                <TopBar.PanelTabs
                  tabs={[
                    ...(!split
                      ? [
                          {
                            ref: "chat",
                            title: t("sessions.dock.chat"),
                            openedAt: 0,
                          },
                        ]
                      : []),
                    ...titleTabs,
                  ].map((tab) => ({
                    id: tab.ref,
                    kind: (tab.ref.startsWith("preview:")
                      ? "files"
                      : tab.ref === "chat"
                        ? "thread"
                        : tab.ref === "agents"
                          ? "agent"
                          : tab.ref.split(":")[0]) as PanelTabKind,
                    title: tab.title,
                  }))}
                  active={active}
                  title={(tab) => tab.title ?? ""}
                  kinds={[]}
                  onDragStart={
                    expanded
                      ? (id, event) =>
                          event.dataTransfer.setData(PANEL_DRAG_TYPE, id)
                      : undefined
                  }
                  workspaceApi={dockApi}
                  onMove={
                    expanded
                      ? (id, position) => {
                          moveDockTab(dockApi.current, id, position);
                        }
                      : undefined
                  }
                  onRename={rename}
                  onChange={choose}
                  onReopen={() => {
                    const ref = reopenTab(key);
                    if (ref) select(ref);
                  }}
                  onClose={close}
                  onReorder={(ids) =>
                    updateTabs(key, (s) => ({
                      ...s,
                      order: ids,
                      tabs: ids
                        .map((id) => s.tabs.find((tab) => tab.ref === id))
                        .filter((tab): tab is PanelTab => tab != null),
                    }))
                  }
                  onAdd={add}
                />
              )}
              {controls}
            </>
          ) : null}
          <TopBar.PanelToggle
            open={entries.open === true && active != null}
            onToggle={() =>
              select(
                entries.open && active ? undefined : (entries.last ?? "changes")
              )
            }
          />
        </TopBarPanelSlot>
        {registerHotkeys(
          () => cycle(1),
          () => cycle(-1),
          () => active && active !== "chat" && close(active),
          () => add("terminal")
        )}
        <PanelWorkspace
          onReopen={() => {
            const ref = reopenTab(key);
            if (ref) select(ref);
          }}
          onRename={rename}
          onGroupCountChange={setGroups}
          onAdd={add}
          scope={key}
          apiRef={dockApi}
          open={entries.open === true && active != null}
          expanded={expanded}
          active={active ?? null}
          onSelect={select}
          onClose={close}
          tabs={[
            {
              id: "chat",
              title: t("sessions.dock.chat"),
              content: () => <PaneBoundary resetKey={key}>{chat}</PaneBoundary>,
            },
            ...entries.tabs.map((tab) => ({
              id: tab.ref,
              title: tab.title,
              content: (visible: boolean) => (
                <PaneBoundary resetKey={tab.ref}>
                  <Suspense fallback={<TabPending />}>
                    {renderTab(tab, visible, () => close(tab.ref))}
                  </Suspense>
                </PaneBoundary>
              ),
            })),
          ]}
        />
      </div>
    </ViewTransition>
  );
};
