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
  GitPullRequest,
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
import { useDockColumns } from "#renderer/components/panel-workspace/columns";
import { useTabsRailPlacement } from "#renderer/components/tabs-rail/placement";
import { usePrefs } from "#renderer/data/db/prefs";
import { followNotices } from "#renderer/data/queries/notices";
import { TopBar } from "#renderer/features/shell/top-bar";
import { TopBarPanelSlot } from "#renderer/features/shell/top-bar-slots";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import {
  useShellLayout,
  useShellWidthSelect,
} from "#renderer/lib/shell-breakpoints";
import type { PanelTabKind } from "#renderer/lib/side-panel/store";
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
  updateTabs,
  focusTab,
  type PanelTab,
} from "./panel-tabs-store";
export interface SessionDockProps {
  row: SessionRow;
  chat: ReactNode;
  /**
   * `useCodeProject`: false steps the developer tools back. The launcher
   * leaves them out and `+` lists them last; an open tab stays as it is.
   */
  codeProject?: boolean;
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
/** The tabs only code needs; put forward in a code project alone. */
const DEVELOPER_KINDS: ReadonlySet<string> = new Set([
  "terminal",
  "files",
  "changes",
  "pr",
]);
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
  chat,
  codeProject = true,
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
    return navigate({
      to: "/sessions/$sessionId",
      params: { sessionId: row.id },
      search: (previous) => ({ ...previous, tab }),
      replace: true,
      transition: "none",
    });
  };
  const normalizeSelection = useEffectEvent(select);
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
          openTab(key, {
            ref: `terminal:${event.state.terminalId}`,
            title: t("sessions.dock.terminal"),
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
      title: t(`sessions.dock.${kind}`),
      ...(shell ? { shell } : {}),
    });
    select(ref);
  };
  const kinds = [
    ...(IS_ELECTRON ? ["browser"] : []),
    "terminal",
    "files",
    "changes",
    "agents",
    ...(IS_ELECTRON && device.data?.enabled ? ["device"] : []),
    // Off, the tab is not offered; one already open says why it is empty.
    ...(github ? ["pr"] : []),
  ];
  const forward = codeProject
    ? kinds
    : kinds.filter((kind) => !DEVELOPER_KINDS.has(kind));
  const aside = codeProject
    ? []
    : kinds.filter((kind) => DEVELOPER_KINDS.has(kind));
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
  const kindItem = (kind: string) => {
    const Icon = KIND_ICONS[kind] ?? Terminal;
    return (
      <DropdownMenuItem key={kind} onClick={() => add(kind)}>
        <Icon />
        <span className="min-w-0 truncate">{t(`sessions.dock.${kind}`)}</span>
      </DropdownMenuItem>
    );
  };
  const controls = (
    <TopBar.Group className="titlebar-nodrag shrink-0 self-start px-1">
      {
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<TopBar.IconButton label={t("sessions.dock.add")} />}
          >
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="titlebar-nodrag w-56">
            {codeProject ? (
              <DropdownMenuGroup>
                {shellItems}
                {kinds.map(kindItem)}
              </DropdownMenuGroup>
            ) : (
              <>
                <DropdownMenuGroup>{forward.map(kindItem)}</DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {shellItems}
                  {aside.map(kindItem)}
                </DropdownMenuGroup>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
      <TopBar.IconButton
        label={t("sessions.dock.full")}
        aria-pressed={expanded}
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
        {expanded ? <Minimize /> : <Maximize />}
      </TopBar.IconButton>
    </TopBar.Group>
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
          <TopBar.PanelToggle
            open={entries.open === true && active != null}
            onToggle={() =>
              select(
                entries.open && active ? undefined : (entries.last ?? LAUNCHER)
              )
            }
          />
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
        <PanelWorkspace
          scope={key}
          apiRef={dockApi}
          open={entries.open === true && active != null}
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
                      <TabLauncher kinds={forward} onOpen={launch} />
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
