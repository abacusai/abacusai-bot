import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  terminalShellsForPlatform,
  type TerminalShellId,
} from "@abacus-ai/contract/terminal-shells";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { Plus, X, Maximize, Minimize } from "lucide-react";
import {
  addTransitionType,
  startTransition,
  ViewTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  Fragment,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";

import { PaneBoundary } from "#renderer/components/page-state";
import { useDb } from "#renderer/data/db";
import { createPaneWidthWriter, usePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/live";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "#renderer/ui/resizable";
import { Tabs, TabsList, TabsTrigger } from "#renderer/ui/tabs";

import { useSessionsTransport, useGitState } from "../data/queries";
import {
  getTerminalView,
  disposeTerminalView,
} from "../terminal/terminal-registry";
import {
  dockReducer,
  dockLeaves,
  dockMinimum,
  foldedDock,
  type DockNode,
} from "./dock-store";
import { clampChatWidth } from "./layout";
import {
  panelTabsStore,
  EMPTY_TABS,
  openTab,
  openTerminalTab,
  closeTab,
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
const terminalId = () => `terminal:terminal-${crypto.randomUUID()}`;
export const SessionDock = ({
  row,
  chat,
  renderTab,
  registerHotkeys,
}: SessionDockProps) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const db = useDb();
  const prefs = usePrefs();
  const key = sessionConversationKey(row.workspaceId, row.id);
  const search = useSearch({ strict: false }) as {
    view?: string;
    tab?: string;
  };
  const entries = useSelector(panelTabsStore, (s) => s[key] ?? EMPTY_TABS);
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({
    width: window.innerWidth - 56,
    height: window.innerHeight - 48,
  });
  const [full, setFull] = useState<{
    key: string;
    from: string | undefined;
    view: string;
  } | null>(null);
  const [terminalSnapshot, setTerminalSnapshot] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const git = useGitState({ workspaceId: row.workspaceId, sessionId: row.id });
  const device = useQuery(
    transport.orpc.devices.status.queryOptions({
      input: {},
      enabled: IS_ELECTRON,
    })
  );
  const shells = useQuery(
    transport.orpc.terminal.shell.get.queryOptions({ input: {} })
  );
  const split =
    window.innerWidth >= 1100 &&
    size.width >= 728 &&
    (full?.key === key && full.from === search.view
      ? full.view
      : search.view) !== "full" &&
    search.tab != null;
  const active = search.tab;
  useEffect(() => {
    if (active) focusTab(key, active);
  }, [key, active, entries.tabs]);
  const showChat = active === "chat" || active == null || split;
  const tree: DockNode = entries.tree ?? {
    kind: "leaf",
    id: "root",
    tabs: entries.tabs.map((tab) => tab.ref),
    active: active ?? entries.last,
  };
  const shown = foldedDock(
    tree,
    split ? size.width - 368 : size.width,
    size.height - (active ? 36 : 0),
    active ?? null
  );
  const chatPanel = usePanelRef();
  const minimumDockWidth = Math.max(360, dockMinimum(shown, "width"));
  const restoreChatSize = useEffectEvent(() => {
    chatPanel.current?.resize(
      !showChat
        ? 0
        : !split
          ? "100%"
          : clampChatWidth(
              prefs.panes["sessions.chat"] ?? 480,
              size.width,
              minimumDockWidth + 8
            )
    );
  });
  useEffect(() => {
    restoreChatSize();
  }, [split, showChat, size.width, minimumDockWidth]);
  const chatWriter = useState(() =>
    createPaneWidthWriter(db, "sessions.chat")
  )[0];
  const [writers] = useState(
    () => new Map<string, ReturnType<typeof createPaneWidthWriter>>()
  );
  const writePane = (id: string, pixels: number) => {
    let writer = writers.get(id);
    if (!writer) {
      writer = createPaneWidthWriter(db, id);
      writers.set(id, writer);
    }
    writer.write(pixels);
  };
  useEffect(
    () => () => {
      chatWriter.flush();
      for (const writer of writers.values()) writer.flush();
    },
    [chatWriter, writers]
  );
  const select = (tab: string | undefined) =>
    void navigate({
      to: ".",
      search: (p: Record<string, unknown>) => ({ ...p, tab }),
      replace: true,
      transition: "none",
    } as never);
  const close = (ref: string) => {
    if (!/^(terminal|browser|preview):/.test(ref)) {
      select(undefined);
      return;
    }
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
    const observer = new ResizeObserver((list) => {
      const rect = list[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
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
    if (active === "chat" && split)
      normalizeSelection(entries.last ?? undefined);
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
      ...(split ? [] : ["chat"]),
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
  const move = (
    tab: string,
    target: string,
    edge?: "left" | "right" | "top" | "bottom",
    before?: string
  ) => {
    const next = dockReducer(tree, {
      type: "move",
      tab,
      target,
      ...(edge ? { edge } : {}),
      ...(before ? { before } : {}),
      id: crypto.randomUUID(),
    });
    if (
      dockMinimum(next, "width") > (split ? size.width - 368 : size.width) ||
      dockMinimum(next, "height") > size.height - 36
    )
      return;
    updateTabs(key, (s) => ({ ...s, tree: next }));
    setDrag(null);
  };
  const controls = (
    <div className="flex shrink-0 items-center gap-1 px-1">
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
        <DropdownMenuContent>
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
                {t("sessions.terminal.newShell", {
                  shell: t(`terminalShells.${shell.labelKey}.label`),
                })}
              </DropdownMenuItem>
            ))}
            {[
              ...(IS_ELECTRON ? ["browser"] : []),
              "terminal",
              "files",
              ...(git?.gitChanges.length ? ["changes"] : []),
              "agents",
              ...(IS_ELECTRON && device.data?.enabled ? ["device"] : []),
            ].map((kind) => (
              <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                {t(`sessions.dock.${kind}`)}
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
          const view = split ? "full" : "split";
          const pending = { key, from: search.view, view };
          startTransition(() => {
            addTransitionType("session-view");
            setFull(pending);
          });
          void navigate({
            to: ".",
            search: (p: Record<string, unknown>) => ({ ...p, view }),
            replace: true,
            transition: "none",
          } as never)
            .finally(() =>
              setFull((current) => (current === pending ? null : current))
            )
            .catch(() => {});
        }}
      >
        {split ? <Maximize /> : <Minimize />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("sessions.dock.close")}
        onClick={() => select(undefined)}
      >
        <X />
      </Button>
    </div>
  );
  const renderTree = (node: DockNode): ReactNode =>
    node.kind === "split" ? (
      <ResizablePanelGroup
        orientation={node.orientation}
        key={node.id}
        className="min-h-0 min-w-0"
      >
        {node.children.map((child, i) => (
          <Fragment key={child.id}>
            {i ? <ResizableHandle /> : null}
            <ResizablePanel
              minSize={dockMinimum(
                child,
                node.orientation === "horizontal" ? "width" : "height"
              )}
              defaultSize={prefs.panes[`sessions.dock.${node.id}.${child.id}`]}
              onResize={(size) => {
                if (i < node.children.length - 1)
                  writePane(
                    `sessions.dock.${node.id}.${child.id}`,
                    size.inPixels
                  );
              }}
            >
              {renderTree(child)}
            </ResizablePanel>
          </Fragment>
        ))}
      </ResizablePanelGroup>
    ) : (
      <div
        className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (drag) move(drag, node.id);
        }}
      >
        <Tabs
          value={node.tabs.includes(active ?? "") ? active : node.active}
          onValueChange={(value) => {
            if (typeof value === "string") select(value);
          }}
        >
          <div data-tab-header className="flex min-w-0 items-center">
            <TabsList
              variant="line"
              className="min-w-0 flex-1 justify-start overflow-auto px-2"
            >
              {!split && dockLeaves(shown)[0]?.id === node.id ? (
                <TabsTrigger value="chat">
                  {t("sessions.dock.chat")}
                </TabsTrigger>
              ) : null}
              {node.tabs.map((ref) => {
                const tab = entries.tabs.find((tab) => tab.ref === ref);
                return tab ? (
                  <div
                    key={ref}
                    className="flex shrink-0 items-center"
                    draggable
                    onDragStart={() => setDrag(ref)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (drag && drag !== ref)
                        move(drag, node.id, undefined, ref);
                    }}
                    onDragEnd={() => setDrag(null)}
                    onAuxClick={(e) => {
                      if (e.button === 1) close(ref);
                    }}
                  >
                    <TabsTrigger
                      value={ref}
                      className="max-w-48 truncate"
                      title={tab.title}
                      onKeyDown={(e) => {
                        if (e.shiftKey && e.key === "F10") {
                          e.preventDefault();
                          select(ref);
                          const header =
                            e.currentTarget.closest("[data-tab-header]");
                          setTimeout(
                            () =>
                              (
                                header?.querySelector(
                                  "[data-tab-menu]"
                                ) as HTMLButtonElement | null
                              )?.click(),
                            0
                          );
                        }
                      }}
                    >
                      {tab.title}
                      {entries.tabs.filter((t) => t.title === tab.title)
                        .length > 1
                        ? ` (${entries.tabs.filter((t) => t.title === tab.title).findIndex((t) => t.ref === tab.ref) + 1})`
                        : ""}
                    </TabsTrigger>
                  </div>
                ) : null;
              })}
            </TabsList>
            {dockLeaves(shown)[0]?.id === node.id && controls}
            <div
              className="flex min-w-0 items-center"
              role="group"
              aria-label={t("sessions.dock.move")}
            >
              {node.tabs.map((ref) => {
                const tab = entries.tabs.find((tab) => tab.ref === ref);
                const selected = node.tabs.includes(active ?? "")
                  ? active
                  : node.active;
                return tab && ref === selected ? (
                  <div key={ref} className="flex min-w-0 items-center">
                    {" "}
                    {/^(terminal|browser|preview):/.test(ref) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("sessions.dock.closeTab", {
                          name: tab.title,
                        })}
                        onClick={() => close(ref)}
                      >
                        <X />
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            data-tab-menu
                            size="icon-sm"
                            variant="ghost"
                            aria-label={t("sessions.dock.move")}
                          />
                        }
                      >
                        ⋯
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuGroup>
                          <DropdownMenuItem
                            onClick={() => move(ref, node.id, "right")}
                          >
                            {t("sessions.dock.moveRight")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => move(ref, node.id, "bottom")}
                          >
                            {t("sessions.dock.moveBelow")}
                          </DropdownMenuItem>
                          {dockLeaves(tree)
                            .filter((l) => l.id !== node.id)
                            .map((leaf) => (
                              <DropdownMenuItem
                                key={leaf.id}
                                onClick={() => move(ref, leaf.id)}
                              >
                                {t("sessions.dock.movePane", { name: leaf.id })}
                              </DropdownMenuItem>
                            ))}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ) : null;
              })}
            </div>
          </div>
        </Tabs>
        <div className="relative min-h-0 min-w-0 flex-1">
          {node.tabs.map((ref) => {
            const tab = entries.tabs.find((tab) => tab.ref === ref);
            const visible =
              active === "chat"
                ? false
                : ref ===
                  (node.tabs.includes(active ?? "") ? active : node.active);
            return tab ? (
              <div
                key={ref}
                data-dock-pane={ref}
                data-visible={visible}
                className="size-full min-w-0"
                style={{ display: visible ? undefined : "none" }}
              >
                <PaneBoundary resetKey={tab.ref}>
                  {renderTab(tab, visible, () => close(ref))}
                </PaneBoundary>
              </div>
            ) : null;
          })}
        </div>
        {drag
          ? (["left", "right", "top", "bottom"] as const).map((edge) => (
              <div
                key={edge}
                data-drop-edge={edge}
                className={`border-primary bg-primary/10 absolute border-2 ${edge === "left" ? "inset-y-9 left-0 w-10" : edge === "right" ? "inset-y-9 right-0 w-10" : edge === "top" ? "inset-x-10 top-9 h-10" : "inset-x-10 bottom-0 h-10"}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  move(drag, node.id, edge);
                }}
              />
            ))
          : null}
      </div>
    );
  return (
    <ViewTransition
      default="none"
      update={{ "session-view": "session-view", default: "none" }}
    >
      <div
        ref={host}
        data-slot="session-dock"
        data-view={split ? "split" : "full"}
        className="relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden"
      >
        {registerHotkeys(
          () => cycle(1),
          () => cycle(-1),
          () => active && active !== "chat" && close(active),
          () => add("terminal")
        )}
        {active === "chat" && !split ? (
          <Tabs
            value="chat"
            onValueChange={(value) => select(String(value))}
            className="min-w-0 shrink-0 flex-row items-center border-b"
          >
            <TabsList className="min-w-0 flex-1 justify-start overflow-x-auto">
              <TabsTrigger value="chat">{t("sessions.dock.chat")}</TabsTrigger>
              {entries.tabs.map((tab) => (
                <TabsTrigger
                  key={tab.ref}
                  value={tab.ref}
                  className="max-w-48 truncate"
                >
                  {tab.title}
                </TabsTrigger>
              ))}
            </TabsList>
            {controls}
          </Tabs>
        ) : null}
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 min-w-0 flex-1"
        >
          <ResizablePanel
            id="session-chat"
            data-session-pane="chat"
            panelRef={chatPanel}
            minSize={showChat ? Math.min(360, size.width) : 0}
            maxSize={!showChat ? 0 : undefined}
            defaultSize={
              split
                ? clampChatWidth(
                    prefs.panes["sessions.chat"] ?? 480,
                    size.width,
                    dockMinimum(shown, "width") + 8
                  )
                : showChat
                  ? "100%"
                  : 0
            }
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              if (
                split &&
                size.inPixels <=
                  host.current!.clientWidth - minimumDockWidth + 1
              )
                chatWriter.write(size.inPixels);
            }}
            style={
              !showChat
                ? { visibility: "hidden", overflow: "hidden" }
                : undefined
            }
          >
            <div className={!showChat ? "hidden" : "h-full min-w-0"}>
              <PaneBoundary resetKey={key}>{chat}</PaneBoundary>
            </div>
          </ResizablePanel>
          {split ? (
            <ResizableHandle
              disableDoubleClick
              className="w-2 shrink-0 bg-transparent"
            />
          ) : null}
          {active && active !== "chat" ? (
            <ResizablePanel
              id="session-panel"
              data-session-pane="tools"
              minSize={split ? Math.max(360, dockMinimum(shown, "width")) : 0}
            >
              {renderTree(shown)}
            </ResizablePanel>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </ViewTransition>
  );
};
