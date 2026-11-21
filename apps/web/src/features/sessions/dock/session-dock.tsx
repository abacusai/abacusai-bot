import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  draftConversationKey,
  sessionConversationKey,
} from "@abacus-ai/contract/conversation-scope";
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
  GitPullRequest,
  Bot,
  Monitor,
  Ellipsis,
  Eraser,
  Pencil,
  Trash2,
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
import { useDockColumns } from "#renderer/components/panel-workspace/columns";
import { useTabsRailPlacement } from "#renderer/components/tabs-rail/placement";
import { usePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/notices";
import { TopBar } from "#renderer/features/shell/top-bar";
import {
  TopBarPanelSlot,
  useTopBarEndActions,
  type TopBarAction,
} from "#renderer/features/shell/top-bar-slots";
import { useAppHotkey } from "#renderer/lib/hotkeys";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  useShellLayout,
  useShellWidthSelect,
} from "#renderer/lib/shell-breakpoints";
import type { PanelTabKind } from "#renderer/lib/side-panel/store";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "#renderer/ui/dropdown-menu";
import { Skeleton } from "#renderer/ui/skeleton";

import { useGithubIntegration, useSessionsTransport } from "../data/queries";
import {
  clearTerminal,
  getTerminalView,
  disposeTerminalView,
} from "../terminal/terminal-registry";
import {
  panelTabsStore,
  EMPTY_TABS,
  openTab,
  openTerminalTab,
  closeTab,
  nextTab,
  reopenTab,
  reconcileTerminals,
  terminalTitle,
  updateTabs,
  focusTab,
  type PanelTab,
} from "./panel-tabs-store";
export interface SessionDockProps {
  row: Pick<SessionRow, "workspaceId" | "id">;
  /**
   * A new chat before its first message: keyed by its draft, the selection
   * kept in the tab store rather than the URL, and only the kinds a draft
   * can show (Files and Changes need the chat's checkout).
   */
  draft?: boolean;
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
/** A fresh panel's tab: the kinds it can open, until one is picked. */
const LAUNCHER = "new";
const KIND_ICONS: Record<string, typeof Terminal> = {
  browser: Globe,
  terminal: Terminal,
  files: Folder,
  changes: GitCompare,
  agents: Bot,
  device: Monitor,
  pr: GitPullRequest,
};
const TabLauncher = ({
  kinds,
  onOpen,
}: {
  kinds: readonly string[];
  onOpen(kind: string): void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      data-slot="dock-launcher"
      className="flex size-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto p-6"
    >
      <p className="text-muted-foreground text-xs">{t("sessions.dock.new")}</p>
      <div className="grid w-full max-w-sm grid-cols-2 gap-2">
        {kinds.map((kind) => {
          const Icon = KIND_ICONS[kind] ?? Terminal;
          return (
            <Button
              key={kind}
              variant="secondary"
              className="h-auto min-h-20 flex-col items-start justify-between gap-2 rounded-2xl p-3 text-start whitespace-normal"
              onClick={() => onOpen(kind)}
            >
              <Icon aria-hidden className="text-muted-foreground size-4" />
              <span>{t(`sessions.dock.${kind}`)}</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
};
export const SessionDock = ({
  row,
  draft = false,
  chat,
  renderTab,
  registerHotkeys,
}: SessionDockProps) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate({ from: "/sessions/$sessionId" });
  const key = draft
    ? draftConversationKey(row.workspaceId, row.id)
    : sessionConversationKey(row.workspaceId, row.id);
  const routeSearch = useSearch({ strict: false }) as {
    tab?: string;
    view?: "full" | "split";
  };
  const [draftView, setDraftView] = useState<"full" | "split">("split");
  const search = draft ? { tab: undefined, view: draftView } : routeSearch;
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
  const prefs = usePrefs();
  const github = useGithubIntegration();
  const narrow = useShellWidthSelect((width) => width < 600);
  const expanded =
    entries.open === true &&
    (search.view === "full" ||
      (!IS_ELECTRON &&
        narrow &&
        (active === "files" || !!active?.startsWith("preview:"))));
  const layout = useShellLayout({
    area: "sessions",
    pinned: prefs.sidebar.pinned,
    panelOpen: entries.open === true,
  });
  const split = !expanded && layout.sidePanel !== "drawer";
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
    if (draft) return Promise.resolve();
    return navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: row.id },
      search: (previous) => ({ ...previous, tab }),
      replace: true,
      transition: "none",
    });
  };
  const normalizeSelection = useEffectEvent(select);
  // Closing a terminal that runs a program (a dev server, an editor) stops
  // it: ask first. At its prompt, or where the platform can't tell, it
  // closes at once.
  const [confirmClose, setConfirmClose] = useState<{
    ref: string;
    program: string;
  } | null>(null);
  const close = (ref: string) => {
    if (!ref.startsWith("terminal:")) return closeNow(ref);
    const id = ref.slice(9);
    void getTerminalView(`${key}:${id}`)
      .then((view) =>
        view.generation == null
          ? { program: null }
          : transport.client.terminal.busy({
              conversationKey: key,
              terminalId: id,
              generation: view.generation,
            })
      )
      .catch(() => ({ program: null }))
      .then(({ program }) =>
        program ? setConfirmClose({ ref, program }) : closeNow(ref)
      );
  };
  const closeNow = (ref: string) => {
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
    if (active !== ref) {
      closeTab(key, ref);
      return;
    }
    // The URL leaves the tab first: while it still names an open-once kind
    // (Files, Changes), the dock reopens that kind.
    void select(nextTab(key, ref)).then(() => closeTab(key, ref));
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
        } else {
          // An agent's terminal appears without taking the focus.
          const previous = panelTabsStore.state[key]?.last;
          const ref = `terminal:${event.state.terminalId}`;
          if (!panelTabsStore.state[key]?.tabs.some((tab) => tab.ref === ref))
            openTab(key, {
              ref,
              title: terminalTitle(key, t("sessions.dock.terminal")),
            });
          if (previous)
            updateTabs(key, (s) =>
              s.tabs.some((tab) => tab.ref === previous)
                ? { ...s, last: previous }
                : s
            );
        }
      },
      abort.signal
    );
    if (IS_ELECTRON)
      void followNotices(
        transport,
        ({ signal }) =>
          transport.client.browser.events({ conversationKey: key }, { signal }),
        (event) => {
          // The tab itself is adopted app-wide (SessionsGlobals); here the
          // chat on screen shows it.
          if (event.type === "runtime-materialized")
            void normalizeSelection(`browser:${event.resourceId}`);
        },
        abort.signal
      );
    return () => abort.abort();
  }, [transport, key, t]);
  useEffect(() => {
    if (
      active &&
      active !== "chat" &&
      !entries.tabs.some((tab) => tab.ref === active) &&
      (!active.startsWith("terminal:") || terminalSnapshot === key)
    ) {
      if (
        ["files", "changes", "agents", "device", "pr", LAUNCHER].includes(
          active
        ) ||
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
      title:
        kind === "terminal"
          ? terminalTitle(key, t("sessions.dock.terminal"))
          : t(`sessions.dock.${kind}`),
      ...(shell ? { shell } : {}),
    });
    select(ref);
  };
  const kinds = draft
    ? [...(IS_ELECTRON ? ["browser"] : []), "terminal"]
    : [
        ...(IS_ELECTRON ? ["browser"] : []),
        "terminal",
        "files",
        "changes",
        "agents",
        ...(IS_ELECTRON && device.data?.enabled ? ["device"] : []),
        // Off, the tab is not offered; one already open says why it is empty.
        ...(github ? ["pr"] : []),
      ];
  // The launcher hands its place to the kind picked on it.
  const launch = (kind: string) => {
    add(kind);
    updateTabs(key, (s) => ({
      ...s,
      tabs: s.tabs.filter((tab) => tab.ref !== LAUNCHER),
    }));
  };
  const titleTabs = [...entries.tabs];
  if (entries.order)
    titleTabs.sort((a, b) => {
      const position = (ref: string) => {
        const index = entries.order!.indexOf(ref);
        return index < 0 ? entries.order!.length : index;
      };
      return position(a.ref) - position(b.ref);
    });
  const rename = (ref: string, title: string) =>
    updateTabs(key, (state) => ({
      ...state,
      tabs: state.tabs.map((tab) =>
        tab.ref === ref ? { ...tab, title } : tab
      ),
    }));
  const shellItems = terminalShellsForPlatform(
    (document.documentElement.dataset.platform ?? "darwin") as NodeJS.Platform
  ).map((shell) => (
    <DropdownMenuItem
      key={shell.id}
      disabled={
        shells.data?.statuses.find((s) => s.id === shell.id)?.available ===
        false
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
  ));
  const [renameRequest, setRenameRequest] = useState<{
    id: string;
    at: number;
  } | null>(null);
  const activeTerminal = active?.startsWith("terminal:") ? active : null;
  const clearTab = (ref: string) =>
    void getTerminalView(`${key}:${ref.slice(9)}`)
      .then((view) => {
        clearTerminal(view.term);
        view.term.focus();
      })
      .catch(() => {});
  // Keyboard paths for what the … menu does, through the command menu, and
  // between the chat box and the terminal (Esc belongs to the shell).
  // After any open dialog (the command menu) has closed and handed the
  // focus back to where it was opened.
  const afterDialogs = (fn: () => void) => {
    let frames = 0;
    const tick = () => {
      if (document.querySelector('[role="dialog"]') && frames++ < 60)
        requestAnimationFrame(tick);
      else setTimeout(fn, 0);
    };
    requestAnimationFrame(tick);
  };
  const focusTerminal = (ref: string) =>
    void getTerminalView(`${key}:${ref.slice(9)}`)
      .then((view) => afterDialogs(() => view.term.focus()))
      .catch(() => {});
  const latestTerminal = entries.tabs.findLast((tab) =>
    tab.ref.startsWith("terminal:")
  )?.ref;
  useAppHotkey(
    null,
    () => {
      if (!latestTerminal) return;
      const ref = activeTerminal ?? latestTerminal;
      if (ref !== active) void select(ref);
      focusTerminal(ref);
    },
    { actionId: "focus-terminal", enabled: latestTerminal != null }
  );
  useAppHotkey(
    null,
    () =>
      afterDialogs(() =>
        document
          .querySelector<HTMLTextAreaElement>(
            '[data-slot="session-dock"] [data-slot="composer"] textarea'
          )
          ?.focus()
      ),
    { actionId: "focus-composer" }
  );
  useAppHotkey(
    null,
    () =>
      activeTerminal &&
      setRenameRequest({ id: activeTerminal, at: Date.now() }),
    { actionId: "rename-terminal", enabled: activeTerminal != null }
  );
  useAppHotkey(null, () => activeTerminal && clearTab(activeTerminal), {
    actionId: "clear-terminal",
    enabled: activeTerminal != null,
  });
  useAppHotkey(null, () => activeTerminal && close(activeTerminal), {
    actionId: "kill-terminal",
    enabled: activeTerminal != null,
  });
  const controls = (
    <TopBar.Group className="titlebar-nodrag shrink-0 self-start px-1">
      {activeTerminal ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <TopBar.IconButton label={t("sessions.terminal.actions")} />
            }
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="titlebar-nodrag w-56">
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() =>
                  setRenameRequest({ id: activeTerminal, at: Date.now() })
                }
              >
                <Pencil />
                {t("shell.panel.renameTab")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => clearTab(activeTerminal)}>
                <Eraser />
                {t("sessions.terminal.clear")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => close(activeTerminal)}>
                <Trash2 />
                {t("sessions.terminal.kill")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>{shellItems}</DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<TopBar.IconButton label={t("sessions.dock.add")} />}
          >
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="titlebar-nodrag w-56">
            <DropdownMenuGroup>
              {shellItems}
              {kinds.map((kind) => {
                const Icon = KIND_ICONS[kind] ?? Terminal;
                return (
                  <DropdownMenuItem key={kind} onClick={() => add(kind)}>
                    <Icon />
                    <span className="min-w-0 truncate">
                      {t(`sessions.dock.${kind}`)}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      <TopBar.IconButton
        label={t("sessions.dock.full")}
        aria-pressed={expanded}
        onClick={() => {
          if (draft) return setDraftView(expanded ? "split" : "full");
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
        {expanded ? <Minimize /> : <Maximize />}
      </TopBar.IconButton>
    </TopBar.Group>
  );
  // One click to the panel's main tools, terminal first, at the chat's edge
  // beside the panel; `+` keeps the rest. A kind already on screen closes
  // the panel; otherwise its latest tab comes up, or a new one.
  useTopBarEndActions(
    [
      "terminal",
      ...(IS_ELECTRON ? ["browser"] : []),
      ...(draft ? [] : ["changes", "files"]),
    ].map((kind): TopBarAction => {
      const Icon = KIND_ICONS[kind]!;
      const ofKind = (ref: string) =>
        ref === kind || ref.startsWith(`${kind}:`);
      const shown = entries.open === true && !!active && ofKind(active);
      const onSelect = () => {
        if (shown) return void select(undefined);
        const latest = entries.tabs.findLast((tab) => ofKind(tab.ref));
        if (latest) select(latest.ref);
        else add(kind);
      };
      return {
        id: `panel-shortcut:${kind}`,
        label: t(`sessions.dock.${kind}`),
        icon: <Icon />,
        onSelect,
        render: (
          <TopBar.IconButton
            label={t(`sessions.dock.${kind}`)}
            aria-pressed={shown}
            data-active={shown ? "" : undefined}
            data-slot="panel-shortcut"
            className="data-active:bg-sidebar-accent data-active:text-sidebar-foreground"
            onClick={onSelect}
          >
            <Icon />
          </TopBar.IconButton>
        ),
      };
    })
  );
  const railPlacement = useTabsRailPlacement();
  const dockColumns = useDockColumns();
  const rail =
    entries.open && active ? (
      <>
        {
          <TopBar.PanelTabs
            columns={
              expanded && railPlacement === "titlebar" ? dockColumns : undefined
            }
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
                ? (id, event) => event.dataTransfer.setData(PANEL_DRAG_TYPE, id)
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
            renameRequest={renameRequest}
            onChange={select}
            renderIcon={(tab) =>
              tab.id === LAUNCHER ? (
                <Plus className="size-3.5 shrink-0" aria-hidden />
              ) : undefined
            }
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
        }
        {controls}
      </>
    ) : null;
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
          {railPlacement === "titlebar" && rail}
          {/* A new chat opens and hides its panel from the icon row. */}
          {!draft && (
            <TopBar.PanelToggle
              open={entries.open === true && active != null}
              onToggle={() =>
                select(
                  entries.open && active
                    ? undefined
                    : (entries.last ?? LAUNCHER)
                )
              }
            />
          )}
        </TopBarPanelSlot>
        {railPlacement === "panel" && (
          <div className="titlebar-nodrag flex min-w-0 shrink-0 items-center">
            {rail}
          </div>
        )}
        {registerHotkeys(
          () => cycle(1),
          () => cycle(-1),
          () => active && active !== "chat" && close(active),
          () => add("terminal")
        )}
        <AlertDialog
          open={confirmClose != null}
          onOpenChange={(open) => {
            if (!open) setConfirmClose(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("sessions.terminal.busyTitle", {
                  program: confirmClose?.program ?? "",
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("sessions.terminal.busyBody", {
                  program: confirmClose?.program ?? "",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("sessions.common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (confirmClose) closeNow(confirmClose.ref);
                  setConfirmClose(null);
                }}
              >
                {t("sessions.terminal.busyConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <PanelWorkspace
          scope={key}
          apiRef={dockApi}
          open={entries.open === true && active != null}
          wide={entries.tabs.some((tab) => tab.ref.startsWith("terminal:"))}
          expanded={expanded}
          active={active ?? null}
          onSelect={select}
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
                    {tab.ref === LAUNCHER ? (
                      <TabLauncher kinds={kinds} onOpen={launch} />
                    ) : (
                      renderTab(tab, visible, () => close(tab.ref))
                    )}
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
