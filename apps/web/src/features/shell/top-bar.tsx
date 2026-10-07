/**
 * The title bar (spec 01 §7.4, canvas `TopBar`, page 5). Laid out from the
 * window-chrome variables only: `--titlebar-x` (macOS traffic lights) and
 * `--titlebar-end` (caption buttons) pad the bar, so no platform branches.
 * The whole bar drags the window; every interactive child is no-drag.
 *
 * Compound: Root, Leading, Identity, Actions, PanelTabs, PanelToggle.
 */
import {
  useCanGoBack,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import type { DockviewApi } from "dockview-react";
import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  LayoutPanelLeft,
  LayoutPanelTop,
  Terminal,
  Globe,
  Folder,
  GitCompare,
  Bot,
  FileText,
  Brain,
  PanelLeft,
  PanelRight,
  Plus,
  X,
} from "lucide-react";
import { Reorder } from "motion/react";
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { AppBrandMark } from "#renderer/components/app-icon";
import { cn } from "#renderer/lib/cn";
import {
  reducedTransition,
  springs,
  useMotionPreference,
} from "#renderer/lib/motion";
import { useCanGoForward } from "#renderer/lib/navigation/can-go-forward";
import type { SidePanelTabId } from "#renderer/lib/navigation/search";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "#renderer/ui/tabs";

import type { PanelTab, PanelTabKind } from "./panel-store";
import { shellStore } from "./shell-store";
import { setIdentityTarget, useTopBarActionList } from "./top-bar-slots";

const BarButton = ({
  label,
  className,
  ...props
}: { label: string } & ComponentProps<typeof Button>) => (
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label={label}
    title={label}
    className={cn(
      "titlebar-nodrag text-muted-foreground hover:text-sidebar-foreground phone:size-10 phone:rounded-full phone:[&_svg]:size-5 phone:active:bg-foreground/[0.08] size-7",
      className
    )}
    {...props}
  />
);

const Root = ({ children }: { children: ReactNode }) => (
  <header
    data-slot="topbar"
    className="titlebar-drag text-muted-foreground phone:pr-1.5 phone:text-[16px] flex h-(--toolbar-h) min-w-0 items-center gap-0 pr-[max(var(--titlebar-end),var(--pane-inset))] pl-(--titlebar-x) text-[13px] select-none"
  >
    {children}
  </header>
);

/**
 * Back, forward, sidebar toggle and the brand: the app icon, with the app
 * name while the sidebar is pinned. With a
 * sidebar column in layout its width ends at the content pane's left edge;
 * `min-width: min-content` keeps the buttons whole when the reservation is
 * wider than the column (the 88 px strip under macOS lights).
 */
const Leading = ({
  sidebarInLayout,
  showAppName,
  sidebarExpanded,
  onToggleSidebar,
}: {
  sidebarInLayout: boolean;
  showAppName: boolean;
  /** Set while the sidebar floats: whether it is showing. */
  sidebarExpanded?: boolean;
  onToggleSidebar(): void;
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const settings = useRouterState({
    select: (s) => s.location.pathname.startsWith("/settings"),
  });
  const navigate = useAppNavigate();
  const canGoForward = useCanGoForward();
  return (
    <div
      data-slot="topbar-leading"
      className={cn(
        "phone:pl-1.5 flex items-center gap-0.5 pl-2",
        sidebarInLayout
          ? "w-[calc(var(--rail-w)+var(--sidebar-occupied-w)-var(--titlebar-x))] min-w-min flex-none"
          : "flex-none pr-2.5"
      )}
    >
      <BarButton
        // Phones keep their browser's own back gesture; settings still
        // needs a way out.
        className={settings ? undefined : "phone:hidden"}
        label={t(settings ? "settings.backToApp" : "shell.topBar.back")}
        disabled={!settings && !canGoBack}
        onClick={() =>
          settings
            ? void navigate({
                ...shellStore.state.lastLocationOutsideSettings,
                to: shellStore.state.lastLocationOutsideSettings.pathname,
                transition: "settings-out",
                // A location remembered at runtime.
              } as never)
            : router.history.back()
        }
      >
        <ArrowLeft />
      </BarButton>
      <BarButton
        className="phone:hidden"
        label={t("shell.topBar.forward")}
        disabled={!canGoForward}
        onClick={() => router.history.forward()}
      >
        <ArrowRight />
      </BarButton>
      <BarButton
        label={t("shell.topBar.toggleSidebar")}
        aria-expanded={sidebarExpanded}
        data-testid="sidebar-toggle"
        onClick={onToggleSidebar}
      >
        <PanelLeft />
      </BarButton>
      {/* The brand: the app icon always, the name only while the sidebar
          is pinned (icon only when it is collapsed or floating). */}
      <span
        data-slot="topbar-brand"
        className="text-sidebar-foreground flex min-w-0 items-center gap-2 pl-2 font-semibold"
      >
        <AppBrandMark size={20} className="shrink-0" />
        {showAppName && (
          <span
            data-slot="topbar-app-name"
            className="min-w-0 truncate whitespace-nowrap"
          >
            {t("shell.appName")}
          </span>
        )}
      </span>
    </div>
  );
};

const Identity = ({
  status,
  statusText,
  badge,
  children,
}: {
  status: boolean;
  statusText?: string;
  badge?: ReactNode;
  /** Static content instead of the routes' portal slot (the gallery). */
  children?: ReactNode;
}) => {
  const { t } = useTranslation();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const area = pathname.split("/")[1];
  const fallback =
    area === "bots"
      ? t("shell.rail.bots")
      : area === "sessions"
        ? t("shell.rail.sessions")
        : area === "routines"
          ? t("shell.rail.routines")
          : area === "artifacts"
            ? t("shell.rail.artifacts")
            : area === "library"
              ? t("shell.rail.library")
              : area === "settings"
                ? t(
                    pathname.split("/")[2] === "keyboard"
                      ? "settings.pages.keyboard"
                      : pathname.split("/")[2] === "language"
                        ? "settings.pages.language"
                        : pathname.split("/")[2] === "browser"
                          ? "settings.pages.browser"
                          : pathname.split("/")[2] === "devices"
                            ? "settings.pages.devices"
                            : "settings.sidebar.label"
                  )
                : t("shell.appName");
  return (
    <div
      data-slot="topbar-identity"
      className="flex min-w-0 flex-1 items-center gap-2 pr-2"
    >
      {children === undefined ? (
        <>
          <div
            ref={setIdentityTarget}
            // No overflow clip: the bot identity's parts travel out of the
            // slot into the transcript header (bots.css).
            className="flex max-w-full min-w-0 flex-1 items-center gap-2 empty:hidden [&:not(:empty)+span]:hidden [&>*]:max-w-full [&>*]:min-w-0 [&>button]:shrink"
          />
          <span className="text-sidebar-foreground phone:font-semibold min-w-0 truncate font-medium">
            {fallback}
          </span>
        </>
      ) : (
        <div className="flex max-w-full min-w-0 flex-1 items-center gap-2 overflow-hidden [&>*]:max-w-full [&>*]:min-w-0 [&>button]:shrink">
          {children}
        </div>
      )}
      {status && statusText != null && (
        <span
          data-slot="topbar-status"
          className="shell-lg:inline hidden truncate"
        >
          {statusText}
        </span>
      )}
      {badge}
    </div>
  );
};
const Actions = ({
  folded,
  tabs = [],
}: {
  folded: boolean;
  /** Kinds the strip already shows; a route action of that id is dropped. */
  tabs?: readonly SidePanelTabId[];
}) => {
  const { t } = useTranslation();
  const actions = useTopBarActionList().filter(
    (action) => !tabs.includes(action.id as SidePanelTabId)
  );
  if (actions.length === 0) return null;
  if (folded)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<BarButton label={t("shell.topBar.more")} />}
          data-testid="topbar-more"
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((action) => (
            <DropdownMenuItem key={action.id} onClick={action.onSelect}>
              {action.icon}
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <div
      data-slot="topbar-actions"
      className="flex shrink-0 items-center gap-0.5"
    >
      {actions.map((action) =>
        action.render != null ? (
          <Fragment key={action.id}>{action.render}</Fragment>
        ) : (
          <Button
            key={action.id}
            variant="ghost"
            size="sm"
            className="titlebar-nodrag"
            onClick={action.onSelect}
          >
            {action.icon}
            {action.label}
          </Button>
        )
      )}
    </div>
  );
};

const TAB_CLASS =
  "titlebar-nodrag text-muted-foreground hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-foreground dark:data-active:bg-sidebar-accent dark:data-active:text-sidebar-foreground group/tab flex h-7 max-w-44 min-w-0 flex-none items-center gap-1 rounded-lg border-0 pr-1.5 pl-3 text-[13px] font-medium shadow-none transition-[background-color,color] duration-150 ease-out select-none data-active:pr-1";

/**
 * The panel's tab strip (canvas `BotChatPanel`, `SplitView`, `TitleMac`):
 * pill tabs at the bar controls' height, the active one filled with a close
 * mark, "+" after them, 8 px before the panel toggle (V7). Tabs reorder by
 * drag (motion's Reorder, a spring so a let-go tab keeps its velocity);
 * middle click closes. Switching tabs animates nothing: it happens tens of
 * times a day.
 */
const PanelTabs = ({
  tabs,
  active,
  title,
  kinds,
  onChange,
  onClose,
  onReorder,
  onAdd,
  onDragStart,
  onMove,
  workspaceApi,
}: {
  tabs: readonly PanelTab[];
  active: string | null;
  title(tab: PanelTab): string;
  /** The kinds "+" offers; empty hides it. */
  kinds: readonly PanelTabKind[];
  onChange(id: string): void;
  onClose(id: string): void;
  onReorder(ids: string[]): void;
  onAdd(kind: PanelTabKind): void;
  onDragStart?(id: string, event: React.DragEvent): void;
  workspaceApi?: React.RefObject<DockviewApi | null>;
  onMove?(id: string, position: "left" | "right" | "top" | "bottom"): void;
}) => {
  const { t } = useTranslation();
  const motionPref = useMotionPreference();
  const [moveGroups, setMoveGroups] = useState<{ id: string; title: string }[]>(
    []
  );
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    const selected = list.current?.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]'
    );
    selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (restoreFocus.current && selected) {
      restoreFocus.current = false;
      selected.focus();
    }
  }, [active]);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      element
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" })
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (tabs.length === 0 && kinds.length === 0) return null;
  const ids = tabs.map((tab) => tab.id);
  return (
    <div
      data-slot="topbar-panel-tabs"
      className="mr-2 flex min-w-0 shrink items-center gap-1"
    >
      <Tabs
        value={active ?? undefined}
        onValueChange={(value) => {
          restoreFocus.current =
            list.current?.contains(document.activeElement) ?? false;
          onChange(String(value));
        }}
        className="min-w-0"
      >
        <TabsList
          activateOnFocus
          className="h-auto min-w-0 bg-transparent p-0"
          aria-label={t("shell.topBar.panelTabs")}
        >
          <Reorder.Group
            as="div"
            ref={list}
            axis="x"
            values={ids}
            onReorder={onReorder}
            role="presentation"
            data-tour="topbar-panel-tabs"
            data-topbar-tabs=""
            className="scroll-fade-x flex min-w-0 items-center gap-1 overflow-x-auto"
          >
            {tabs.map((tab) => {
              const selected = tab.id === active;
              const label = title(tab);
              return (
                <Reorder.Item
                  key={tab.id}
                  as="div"
                  value={tab.id}
                  layout="position"
                  transition={
                    motionPref === "reduced"
                      ? reducedTransition
                      : { layout: springs.panel }
                  }
                  whileDrag={{ zIndex: 1 }}
                  dragListener={onDragStart == null}
                  draggable={onDragStart != null}
                  onDragStartCapture={(event) => onDragStart?.(tab.id, event)}
                  className="shrink-0"
                >
                  <TabsTrigger
                    value={tab.id}
                    data-active={selected ? "" : undefined}
                    data-panel-tab-id={tab.id}
                    data-panel-tab-kind={tab.kind}
                    title={label}
                    className={TAB_CLASS}
                    onAuxClick={(event) => {
                      if (event.button === 1) onClose(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Delete" || event.key === "Backspace") {
                        event.preventDefault();
                        onClose(tab.id);
                      }
                    }}
                  >
                    <span className="min-w-0 truncate">{label}</span>
                    {/* A glyph, not a control (a tab may hold no interactive
                  child): the pointer closes here, the keyboard with
                  Delete/Backspace or ⌘W on the tab. */}
                    <span
                      aria-hidden="true"
                      style={
                        tab.id === "chat" ? { display: "none" } : undefined
                      }
                      data-slot="panel-tab-close"
                      title={t("shell.panel.closeTab", { name: label })}
                      className={cn(
                        "hover:bg-foreground/10 flex size-5 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
                        !selected && "hidden group-hover/tab:flex"
                      )}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        onClose(tab.id);
                      }}
                    >
                      <X />
                    </span>
                  </TabsTrigger>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </TabsList>
      </Tabs>
      {onMove && active ? (
        <DropdownMenu
          onOpenChange={(open) => {
            if (open)
              setMoveGroups(
                workspaceApi?.current?.groups
                  .filter(
                    (group) =>
                      group.id !==
                      workspaceApi.current?.getPanel(active)?.group.id
                  )
                  .map((group) => ({
                    id: group.id,
                    title: group.activePanel?.title ?? group.id,
                  })) ?? []
              );
          }}
        >
          <DropdownMenuTrigger
            render={<BarButton label={t("sessions.dock.move")} />}
          >
            <Ellipsis />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {(["left", "right", "top", "bottom"] as const).map((position) => (
              <DropdownMenuItem
                key={position}
                onClick={() => onMove(active, position)}
              >
                {position === "left" || position === "right" ? (
                  <LayoutPanelLeft />
                ) : (
                  <LayoutPanelTop />
                )}
                {t(`sessions.dock.moveDirections.${position}`)}
              </DropdownMenuItem>
            ))}
            {moveGroups.map((group) => (
              <DropdownMenuItem
                key={group.id}
                onClick={() => {
                  const api = workspaceApi?.current;
                  const target = api?.groups.find(
                    (pane) => pane.id === group.id
                  );
                  if (target)
                    api
                      ?.getPanel(active)
                      ?.api.moveTo({ group: target, position: "center" });
                }}
              >
                <LayoutPanelLeft />
                <span className="min-w-0 truncate">
                  {t("sessions.dock.movePane", { name: group.title })}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {kinds.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<BarButton label={t("shell.panel.addTab")} />}
            data-testid="panel-add-tab"
          >
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            collisionPadding={12}
            className="titlebar-nodrag scroll-fade-y max-h-[min(var(--available-height),320px)] w-56 max-w-[calc(100vw-24px)]"
          >
            {kinds.map((kind) => (
              <DropdownMenuItem key={kind} onClick={() => onAdd(kind)}>
                {kind === "browser" ? (
                  <Globe />
                ) : kind === "terminal" ? (
                  <Terminal />
                ) : kind === "files" ? (
                  <Folder />
                ) : kind === "changes" ? (
                  <GitCompare />
                ) : kind === "memory" ? (
                  <Brain />
                ) : kind === "agent" ? (
                  <Bot />
                ) : (
                  <FileText />
                )}
                <span className="min-w-0 truncate">
                  {t(`shell.panel.tabs.${kind}`)}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
};

const PanelToggle = ({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle(): void;
}) => {
  const { t } = useTranslation();
  return (
    <BarButton
      label={open ? t("shell.topBar.closePanel") : t("shell.topBar.openPanel")}
      aria-expanded={open}
      aria-pressed={open}
      data-active={open ? "" : undefined}
      className="data-active:bg-sidebar-accent data-active:text-sidebar-foreground"
      data-testid="panel-toggle"
      onClick={onToggle}
    >
      <PanelRight />
    </BarButton>
  );
};

/** Dev only: the chrome reported `overlay-unavailable` (release-blocking). */
const GeometryBadge = () => {
  const { t } = useTranslation();
  return (
    <Badge variant="destructive" data-testid="geometry-badge">
      {t("shell.topBar.geometryMissing")}
    </Badge>
  );
};

export const TopBar = {
  Root,
  Leading,
  Identity,
  Actions,
  PanelTabs,
  PanelToggle,
  GeometryBadge,
};
