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

import { useDb } from "#next/data/db";
import { createPaneWidthWriter, usePrefs } from "#next/data/db/prefs";
import { followNotices } from "#next/data/queries/live";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#next/ui/dropdown-menu";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "#next/ui/resizable";
import { Tabs, TabsList, TabsTrigger } from "#next/ui/tabs";
import type { SessionRow } from "#shared/contract/rows";
import { sessionConversationKey } from "#shared/conversation-scope";
import {
  terminalShellsForPlatform,
  type TerminalShellId,
} from "#shared/terminal-shells";

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
  closeTab,
  reconcileTerminals,
  updateTabs,
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
    close: () => void
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
  const [full, setFull] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const git = useGitState({ workspaceId: row.workspaceId, sessionId: row.id });
  const device = useQuery(
    transport.orpc.devices.status.queryOptions({ input: {} })
  );
  const shells = useQuery(
    transport.orpc.terminal.shell.get.queryOptions({ input: {} })
  );
  const split =
    size.width + 56 >= 1100 &&
    (full ?? search.view) !== "full" &&
    search.tab != null;
  const active = search.tab;
  const showChat = active === "chat" || active == null || split;
  const tree: DockNode = entries.tree ?? {
    kind: "leaf",
    id: "root",
    tabs: entries.tabs.map((tab) => tab.ref),
    active: active ?? entries.last,
  };
  const shown = foldedDock(
    tree,
    split ? size.width - 360 : size.width,
    size.height,
    active ?? null
  );
  const chatPanel = usePanelRef();
  const minimumDockWidth = Math.max(360, dockMinimum(shown, "width"));
  const restoreChatSize = useEffectEvent(() => {
    if (split)
      chatPanel.current?.resize(
        clampChatWidth(
          prefs.panes["sessions.chat"] ?? 480,
          size.width,
          minimumDockWidth + 8
        )
      );
  });
  useEffect(() => {
    restoreChatSize();
  }, [split, size.width, minimumDockWidth]);
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
      void transport.client.browser.runtime
        .materialize({ conversationKey: key, resourceId: ref.slice(8) })
        .then((state) => transport.client.browser.runtime.close(state.lease))
        .catch(() => {});
    }
    const next = closeTab(key, ref);
    updateTabs(key, (s) => ({
      ...s,
      tree: dockReducer(tree, { type: "close", tab: ref }),
    }));
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
        if (event.type === "snapshot") reconcileTerminals(key, event.states);
        else
          openTab(key, {
            ref: `terminal:${event.state.terminalId}`,
            title: event.state.terminalId,
          });
      },
      abort.signal
    );
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
  }, [transport, key]);
  const normalizeSelection = useEffectEvent(select);
  useEffect(() => {
    if (active === "chat" && split)
      normalizeSelection(entries.last ?? undefined);
    if (
      active &&
      active !== "chat" &&
      !entries.tabs.some((tab) => tab.ref === active) &&
      !active.startsWith("terminal:")
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
  }, [active, split, key, entries.last, entries.tabs, t]);
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
    openTab(key, {
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
      dockMinimum(next, "width") > (split ? size.width - 360 : size.width) ||
      dockMinimum(next, "height") > size.height
    )
      return;
    updateTabs(key, (s) => ({ ...s, tree: next }));
    setDrag(null);
  };
  const renderTree = (node: DockNode): ReactNode =>
    node.kind === "split" ? (
      <ResizablePanelGroup orientation={node.orientation} key={node.id}>
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
        className="relative flex size-full flex-col"
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
          <div data-tab-header className="flex items-center">
            <TabsList
              variant="line"
              className="w-full justify-start overflow-auto px-2"
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
            <div
              className="flex items-center"
              role="group"
              aria-label={t("sessions.dock.move")}
            >
              {node.tabs.map((ref) => {
                const tab = entries.tabs.find((tab) => tab.ref === ref);
                const selected = node.tabs.includes(active ?? "")
                  ? active
                  : node.active;
                return tab && ref === selected ? (
                  <div key={ref} className="flex items-center">
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
        <div className="relative min-h-0 flex-1">
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
                className="size-full"
                style={{ display: visible ? undefined : "none" }}
              >
                {renderTab(tab, visible, () => close(ref))}
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
        className="relative flex size-full min-h-0 flex-col"
      >
        {registerHotkeys(
          () => cycle(1),
          () => cycle(-1),
          () => active && active !== "chat" && close(active)
        )}
        {active ? (
          <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b px-2">
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
                        shell: t(`terminalShells.${shell.labelKey}`),
                      })}
                    </DropdownMenuItem>
                  ))}
                  {[
                    "browser",
                    "terminal",
                    "files",
                    ...(git?.gitChanges.length ? ["changes"] : []),
                    "agents",
                    ...(device.data?.enabled ? ["device"] : []),
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
                startTransition(() => {
                  addTransitionType("session-view");
                  setFull(view);
                });
                void navigate({
                  to: ".",
                  search: (p: Record<string, unknown>) => ({ ...p, view }),
                  replace: true,
                  transition: "none",
                } as never);
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
        ) : null}
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            id="session-chat"
            panelRef={chatPanel}
            minSize={showChat ? 360 : 0}
            defaultSize={
              split
                ? clampChatWidth(
                    prefs.panes["sessions.chat"] ?? 480,
                    size.width,
                    dockMinimum(shown, "width") + 8
                  )
                : size.width
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
                ? {
                    position: "absolute",
                    right: 22,
                    bottom: 22,
                    width: 420,
                    height: "auto",
                    zIndex: 10,
                  }
                : split
                  ? undefined
                  : { flex: 1 }
            }
          >
            <div className={!showChat ? "session-dock-mini" : "h-full"}>
              {chat}
            </div>
          </ResizablePanel>
          {split ? <ResizableHandle disableDoubleClick /> : null}
          {active && active !== "chat" ? (
            <ResizablePanel
              id="session-panel"
              minSize={split ? Math.max(360, dockMinimum(shown, "width")) : 0}
            >
              {renderTree(shown)}
            </ResizablePanel>
          ) : active === "chat" ? (
            <div className="absolute inset-x-0 top-9 h-9">
              <Tabs value="chat">
                <TabsList>
                  <TabsTrigger value="chat">
                    {t("sessions.dock.chat")}
                  </TabsTrigger>
                  {entries.tabs.map((tab) => (
                    <TabsTrigger
                      key={tab.ref}
                      value={tab.ref}
                      onClick={() => select(tab.ref)}
                    >
                      {tab.title}
                      {entries.tabs.filter((t) => t.title === tab.title)
                        .length > 1
                        ? ` (${entries.tabs.filter((t) => t.title === tab.title).findIndex((t) => t.ref === tab.ref) + 1})`
                        : ""}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          ) : null}
        </ResizablePanelGroup>
      </div>
    </ViewTransition>
  );
};
