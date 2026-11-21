import type { DockviewApi } from "dockview-react";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Ellipsis,
  LayoutPanelLeft,
  LayoutPanelTop,
  Terminal,
  Globe,
  Folder,
  GitCompare,
  GitPullRequest,
  Bot,
  FileText,
  Brain,
  Plus,
  X,
} from "lucide-react";
import { Reorder, motion, animate, type HTMLMotionProps } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import {
  columnStripWidth,
  type DockColumn,
} from "#renderer/components/panel-workspace/columns";
import { TitleBarIconButton } from "#renderer/components/title-bar";
import { usePrefs } from "#renderer/data/db/prefs";
import { defaultLook } from "#renderer/lib/bots/avatar";
import { cn } from "#renderer/lib/cn";
import {
  reducedTransition,
  springs,
  useMotionPreference,
} from "#renderer/lib/motion";
import type { PanelTab, PanelTabKind } from "#renderer/lib/side-panel/store";
import { Button } from "#renderer/ui/button";
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "#renderer/ui/command";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";
import { Input } from "#renderer/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Tabs, TabsList, TabsTrigger } from "#renderer/ui/tabs";
import { Tooltip, TooltipTrigger, TooltipContent } from "#renderer/ui/tooltip";

import { railLayout } from "./layout";
import { MIN_TITLE_RAIL_WIDTH } from "./placement";
import { TabLabel } from "./tab-label";
const BarButton = TitleBarIconButton;
const tabIcon = (kind: PanelTabKind) =>
  kind === "browser"
    ? Globe
    : kind === "terminal"
      ? Terminal
      : kind === "files"
        ? Folder
        : kind === "changes"
          ? GitCompare
          : kind === "memory"
            ? Brain
            : kind === "agent"
              ? Bot
              : kind === "pr"
                ? GitPullRequest
                : FileText;
/** The order with `id` dropped beside `target`, after it past its middle; Chat stays first. */
export const dropOrder = (
  ids: readonly string[],
  id: string,
  target: string,
  after: boolean
): string[] => {
  const order = ids.filter((value) => value !== id);
  order.splice(
    id === "chat"
      ? 0
      : Math.max(
          order.includes("chat") ? 1 : 0,
          order.indexOf(target) + (after ? 1 : 0)
        ),
    0,
    id
  );
  return order;
};
/**
 * Draws the native drag preview from a detached copy in `<body>`: the strip
 * scrolls (`overflow-x-auto` clips on both axes) and masks its edges, so the
 * browser's own snapshot of the in-strip element came out clipped.
 */
export const nativeDragImage = (event: React.DragEvent<HTMLElement>) => {
  const { dataTransfer, currentTarget, clientX, clientY } = event;
  if (typeof dataTransfer?.setDragImage !== "function") return;
  const box = currentTarget.getBoundingClientRect();
  const ghost = currentTarget.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("data-dragging");
  ghost.removeAttribute("data-drop");
  Object.assign(ghost.style, {
    position: "fixed",
    top: "-1000px",
    left: "-1000px",
    width: `${box.width}px`,
    height: `${box.height}px`,
    opacity: "1",
    transform: "none",
    pointerEvents: "none",
  });
  ghost.classList.add("bg-sidebar-accent", "rounded-lg");
  document.body.append(ghost);
  dataTransfer.setDragImage(ghost, clientX - box.left, clientY - box.top);
  setTimeout(() => ghost.remove(), 0);
};
const TAB_CLASS =
  "titlebar-nodrag text-muted-foreground hover:text-sidebar-foreground data-active:bg-transparent data-active:text-sidebar-foreground dark:data-active:bg-transparent dark:data-active:text-sidebar-foreground group/tab relative flex h-7 [&>svg]:relative [&>span:not([aria-hidden])]:relative max-w-44 min-w-0 flex-none items-center gap-1 rounded-lg border-0 pr-1.5 pl-3 text-[13px] font-medium shadow-none transition-[background-color,color] duration-150 ease-out select-none data-active:pr-1";

const useTabShortcuts = (
  root: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  {
    tabs,
    active,
    onChange,
    onClose,
    onReopen,
  }: {
    tabs: readonly PanelTab[];
    active: string | null;
    onChange(id: string): void;
    onClose(id: string): void;
    onReopen?(): void;
  }
) => {
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const rail = root.current;
      if (
        !rail ||
        !(
          rail.closest('[data-slot="topbar"]') ||
          rail.closest(".dock-group-island")?.contains(document.activeElement)
        )
      )
        return;
      const index = Number(event.key) - 1;
      const select = index >= 0 && index <= 8 ? tabs[index] : null;
      if (select) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onChange(select.id);
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (active && active !== "chat") onClose(active);
      } else if (
        event.key.toLowerCase() === "t" &&
        event.shiftKey &&
        onReopen
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onReopen();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [enabled, root, active, tabs, onChange, onClose, onReopen]);
};

/** Move and add menus: shared by every strip of a grouped rail. */
const RailControls = ({
  active,
  kinds,
  onAdd,
  onMove,
  workspaceApi,
}: {
  active: string | null;
  kinds: readonly PanelTabKind[];
  onAdd(kind: PanelTabKind): void;
  onMove?(id: string, position: "left" | "right" | "top" | "bottom"): void;
  workspaceApi?: React.RefObject<DockviewApi | null>;
}) => {
  const { t } = useTranslation();
  const [moveGroups, setMoveGroups] = useState<{ id: string; title: string }[]>(
    []
  );
  return (
    <>
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
          <DropdownMenuContent align="end" className="titlebar-nodrag">
            {kinds.map((kind) => {
              const Icon = tabIcon(kind);
              return (
                <DropdownMenuItem key={kind} onClick={() => onAdd(kind)}>
                  <Icon />
                  <span className="min-w-0 truncate">
                    {t(`shell.panel.tabs.${kind}`)}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
};

/**
 * One tab in a rail strip. Motion's pointer reorder uses `Reorder.Item`; a
 * native (dock) drag uses a plain Motion element with `draggable`, whose
 * `onDrag*` props Motion hands to the DOM. `Reorder.Item` adds its own gesture
 * `onDrag`, which would then run on every native `drag` event with no pan info.
 */
const TabItem = ({
  value,
  nativeDrag,
  constraints,
  ...props
}: Omit<HTMLMotionProps<"div">, "layout" | "children"> & {
  children: ReactNode;
  value: string;
  nativeDrag: boolean;
  constraints: React.RefObject<HTMLDivElement | null>;
}) =>
  nativeDrag ? (
    <motion.div {...props} layout="position" draggable />
  ) : (
    <Reorder.Item
      {...props}
      as="div"
      value={value}
      layout
      whileDrag={{ zIndex: 1 }}
      dragConstraints={constraints}
      dragElastic={0.05}
    />
  );

/**
 * The panel's tab strip (canvas `BotChatPanel`, `SplitView`, `TitleMac`):
 * compact tabs with a reachable add button and overflow list. Dockview owns
 * expanded tab dragging; Motion animates rail geometry and the active marker.
 */
const RailSegment = ({
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
  onReopen,
  renderIcon,
  onRename,
  renameRequest,
  controls = true,
  shortcuts = true,
  measureToolbar = true,
  allowTwoRows,
  className,
  style,
}: {
  /** Menus for moving and adding tabs; a grouped rail shares one set. */
  controls?: boolean;
  /** ⌘1-9 / ⌘W / ⇧⌘T; a grouped rail registers them once for all tabs. */
  shortcuts?: boolean;
  /** Whether this strip drives the title bar's `--toolbar-h` row spring. */
  measureToolbar?: boolean;
  allowTwoRows?: boolean;
  className?: string;
  style?: React.CSSProperties;
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
  renderIcon?(tab: PanelTab): ReactNode;
  onReopen?(): void;
  onRename?(id: string, title: string): void;
  /** Opens the rename dialog for a tab from elsewhere (a menu); `at` repeats it. */
  renameRequest?: { id: string; at: number } | null;
  workspaceApi?: React.RefObject<DockviewApi | null>;
  onMove?(id: string, position: "left" | "right" | "top" | "bottom"): void;
}) => {
  const { t } = useTranslation();
  const indicator = useId();
  const [rename, setRename] = useState<{ id: string; title: string } | null>(
    null
  );
  // A request opens the dialog once, during render (no effect round trip).
  const [renameSeen, setRenameSeen] = useState(renameRequest?.at ?? null);
  if (renameRequest && renameRequest.at !== renameSeen) {
    setRenameSeen(renameRequest.at);
    const tab = tabs.find((tab) => tab.id === renameRequest.id);
    if (tab && onRename) setRename({ id: tab.id, title: title(tab) });
  }
  const motionPref = useMotionPreference();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [overflow, setOverflow] = useState(false);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth > 0)
        setCompact(element.clientWidth < MIN_TITLE_RAIL_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [allOpen, setAllOpen] = useState(false);
  const activeTab = tabs.find((tab) => tab.id === active);
  // Native (dock) drag: the source stays in flow as a dimmed placeholder, and
  // the insertion point is an inset edge, so nothing reflows mid-drag.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(
    null
  );
  const prefs = usePrefs();
  const layout = railLayout(
    tabs.length,
    width,
    allowTwoRows ?? prefs.appearance?.allowTwoTabRows === true
  );
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
    const observer = new ResizeObserver(() => {
      setWidth(element.clientWidth);
      setOverflow(element.scrollWidth > element.clientWidth + 1);
      element
        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [tabs.length, layout.mode]);
  useEffect(() => {
    if (!measureToolbar || !root.current?.closest('[data-slot="topbar"]'))
      return;
    const html = document.documentElement;
    let controls: ReturnType<typeof animate> | null = null;
    const resize = () => {
      const style = getComputedStyle(html);
      const base =
        Number.parseFloat(style.getPropertyValue("--titlebar-row-h")) || 40;
      const current =
        Number.parseFloat(style.getPropertyValue("--toolbar-h")) || base;
      controls?.stop();
      if (motionPref === "reduced")
        html.style.setProperty("--toolbar-h", `${base * layout.rows}px`);
      else
        controls = animate(current, base * layout.rows, {
          ...springs.panel,
          onUpdate: (value) =>
            html.style.setProperty("--toolbar-h", `${value}px`),
        });
    };
    resize();
    const observer = new MutationObserver(resize);
    observer.observe(html, {
      attributes: true,
      attributeFilter: ["data-density"],
    });
    return () => {
      controls?.stop();
      observer.disconnect();
    };
  }, [layout.rows, motionPref, measureToolbar]);
  useLayoutEffect(() => {
    const titlebar =
      measureToolbar && !!root.current?.closest('[data-slot="topbar"]');
    return () => {
      if (titlebar) {
        const html = document.documentElement;
        html.style.setProperty(
          "--toolbar-h",
          getComputedStyle(html).getPropertyValue("--titlebar-row-h") || "40px"
        );
      }
    };
  }, [measureToolbar]);
  useEffect(() => {
    const element = list.current;
    if (!element || !overflow) return;
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        element.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [overflow]);
  useTabShortcuts(root, shortcuts, {
    tabs,
    active,
    onChange,
    onClose,
    onReopen,
  });
  if (tabs.length === 0 && kinds.length === 0) return null;
  const ids = tabs.map((tab) => tab.id);
  return (
    <div
      ref={root}
      data-slot="topbar-panel-tabs"
      data-rail-chat={tabs.some((tab) => tab.id === "chat") ? "" : undefined}
      data-rail-mode={compact ? "overflow" : layout.mode}
      data-rail-rows={layout.rows}
      className={cn(
        "titlebar-drag mr-2 flex w-full max-w-full min-w-0 flex-1 items-center gap-1 self-stretch",
        className
      )}
      style={style}
    >
      <Tabs
        value={active ?? undefined}
        onValueChange={(value) => {
          restoreFocus.current =
            list.current?.contains(document.activeElement) ?? false;
          onChange(String(value));
        }}
        className={cn("w-full max-w-full min-w-0", compact && "hidden")}
      >
        <TabsList
          activateOnFocus
          className="h-auto w-full min-w-0 bg-transparent p-0 group-data-horizontal/tabs:h-auto"
          aria-label={t("shell.topBar.panelTabs")}
        >
          <Reorder.Group
            as="div"
            ref={list}
            axis="x"
            values={ids}
            onReorder={(order) =>
              onReorder(
                order.includes("chat")
                  ? ["chat", ...order.filter((id) => id !== "chat")]
                  : order
              )
            }
            role="presentation"
            // The strip scrolls; Motion measures drags through that scroll.
            layoutScroll
            data-topbar-tabs=""
            className={cn(
              // No scroll snapping: a snapped strip follows the tab being
              // dragged, so every tab slid along with it.
              "no-scrollbar flex w-full min-w-0 items-center gap-1 overflow-x-auto",
              overflow && "scroll-fade-x",
              layout.mode === "wrap" && "flex-wrap overflow-x-hidden"
            )}
            style={
              layout.mode === "wrap"
                ? {
                    display: "grid",
                    gridTemplateColumns: `repeat(${layout.columns}, minmax(0,1fr))`,
                  }
                : undefined
            }
          >
            {tabs.map((tab) => {
              const selected = tab.id === active;
              const label = title(tab);
              const tooltipId = `${indicator}-${encodeURIComponent(tab.id)}`;
              return (
                <TabItem
                  key={tab.id}
                  value={tab.id}
                  nativeDrag={onDragStart != null}
                  constraints={list}
                  data-dragging={dragging === tab.id ? "" : undefined}
                  data-drop={
                    dropAt?.id === tab.id
                      ? dropAt.after
                        ? "after"
                        : "before"
                      : undefined
                  }
                  initial={motionPref === "reduced" ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={
                    motionPref === "reduced"
                      ? reducedTransition
                      : { layout: springs.panel }
                  }
                  onDragStartCapture={(event) => {
                    if (!onDragStart) return;
                    onDragStart(tab.id, event);
                    setDragging(tab.id);
                    nativeDragImage(event);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setDropAt(null);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(event.relatedTarget as Node)
                    )
                      setDropAt((value) =>
                        value?.id === tab.id ? null : value
                      );
                  }}
                  onDragOver={(event) => {
                    if (
                      !event.dataTransfer.types.includes(
                        "application/x-abacus-panel"
                      )
                    )
                      return;
                    event.preventDefault();
                    if (dragging === tab.id) return;
                    const box = event.currentTarget.getBoundingClientRect();
                    const after =
                      tab.id === "chat" ||
                      event.clientX > box.left + box.width / 2;
                    setDropAt((value) =>
                      value?.id === tab.id && value.after === after
                        ? value
                        : { id: tab.id, after }
                    );
                  }}
                  onDrop={(event) => {
                    setDragging(null);
                    setDropAt(null);
                    const id = event.dataTransfer.getData(
                      "application/x-abacus-panel"
                    );
                    const target = workspaceApi?.current?.getPanel(tab.id);
                    const dragged = workspaceApi?.current?.getPanel(id);
                    if (!target || !dragged || id === tab.id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    const after = event.clientX > box.left + box.width / 2;
                    const panels = target.group.panels.map((panel) => panel.id);
                    dragged.api.moveTo({
                      group: target.group,
                      index: dropOrder(panels, id, tab.id, after).indexOf(id),
                      position: "center",
                    });
                    if (ids.includes(id))
                      onReorder(dropOrder(ids, id, tab.id, after));
                  }}
                  className={cn(
                    "min-w-0 rounded-lg",
                    "data-dragging:opacity-40 data-[drop=after]:shadow-[inset_-2px_0_0_var(--primary)] data-[drop=before]:shadow-[inset_2px_0_0_var(--primary)]",
                    // Scrolling anyway: each tab as wide as its title needs
                    // (up to the single-row cap), so "Terminal 10" is read
                    // whole rather than cut to "Termi…".
                    layout.mode === "scroll"
                      ? "max-w-44 min-w-28 shrink-0"
                      : layout.mode === "single"
                        ? "max-w-44 flex-1 basis-28"
                        : "flex-1 basis-28"
                  )}
                  style={
                    layout.mode === "single" ? { minWidth: 56 } : undefined
                  }
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <TabsTrigger
                          value={tab.id}
                          data-active={selected ? "" : undefined}
                          data-panel-tab-id={tab.id}
                          data-panel-tab-kind={tab.kind}
                          aria-label={label}
                          aria-describedby={tooltipId}
                          className={cn(
                            TAB_CLASS,
                            "w-full",
                            width / tabs.length < 84 &&
                              layout.mode === "single" &&
                              "px-1"
                          )}
                          onDoubleClick={() => {
                            if (tab.kind === "terminal" && onRename)
                              setRename({ id: tab.id, title: label });
                          }}
                          onAuxClick={(event) => {
                            if (event.button === 1 && tab.id !== "chat")
                              onClose(tab.id);
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === "F2" &&
                              tab.kind === "terminal" &&
                              onRename
                            ) {
                              event.preventDefault();
                              setRename({ id: tab.id, title: label });
                            }
                            if (
                              tab.id !== "chat" &&
                              (event.key === "Delete" ||
                                event.key === "Backspace")
                            ) {
                              event.preventDefault();
                              onClose(tab.id);
                            }
                          }}
                        />
                      }
                    >
                      {selected && (
                        <motion.span
                          aria-hidden
                          className="bg-sidebar-accent pointer-events-none absolute inset-0 rounded-lg"
                          layoutId={indicator}
                          transition={
                            motionPref === "reduced"
                              ? reducedTransition
                              : springs.panel
                          }
                        />
                      )}
                      {renderIcon?.(tab) ??
                        (tab.id === "chat" ? (
                          <BotAvatar
                            look={defaultLook("AbacusAI")}
                            size={18}
                            animate={false}
                          />
                        ) : (
                          (() => {
                            const Icon =
                              tab.id === "chat" ? Bot : tabIcon(tab.kind);
                            return (
                              <Icon className="size-3.5 shrink-0" aria-hidden />
                            );
                          })()
                        ))}
                      <TabLabel
                        label={label}
                        iconOnly={
                          width / tabs.length < 84 && layout.mode === "single"
                        }
                      />
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
                          "hover:bg-foreground/10 relative flex size-5 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5",
                          !selected &&
                            "opacity-0 group-focus-within/tab:opacity-100 group-hover/tab:opacity-100"
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(tab.id);
                        }}
                      >
                        <X />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      role="tooltip"
                      id={tooltipId}
                      side="bottom"
                      className="titlebar-nodrag max-w-80 break-all"
                    >
                      {label}
                    </TooltipContent>
                  </Tooltip>
                </TabItem>
              );
            })}
          </Reorder.Group>
        </TabsList>
      </Tabs>
      {(overflow || compact) && (
        <Popover open={allOpen} onOpenChange={setAllOpen}>
          {/* Folded (too narrow for tabs): the trigger names the tab on
              screen, so the strip still says where you are. */}
          <PopoverTrigger
            render={
              compact ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("shell.topBar.panelTabs")}
                  title={t("shell.topBar.panelTabs")}
                  className="titlebar-nodrag text-sidebar-foreground min-w-0 shrink justify-start gap-1 px-2 text-[13px] font-medium"
                />
              ) : (
                <BarButton label={t("shell.topBar.panelTabs")} />
              )
            }
          >
            {compact && activeTab ? (
              <>
                {(() => {
                  const Icon =
                    activeTab.id === "chat" ? Bot : tabIcon(activeTab.kind);
                  return <Icon className="size-3.5 shrink-0" aria-hidden />;
                })()}
                <span className="min-w-0 truncate">{title(activeTab)}</span>
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              </>
            ) : (
              <ArrowDownToLine />
            )}
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="titlebar-nodrag w-56 gap-0 p-0"
          >
            <Command>
              <CommandInput placeholder={t("shell.panel.searchTabs")} />
              <CommandList className="scroll-fade-y">
                <CommandEmpty>{t("shell.command.empty")}</CommandEmpty>
                <CommandGroup>
                  {tabs.map((tab) => {
                    const Icon = tab.id === "chat" ? Bot : tabIcon(tab.kind);
                    return (
                      <CommandItem
                        key={tab.id}
                        value={tab.id + " " + title(tab)}
                        onSelect={() => {
                          onChange(tab.id);
                          setAllOpen(false);
                        }}
                      >
                        <Icon />
                        <span className="min-w-0 flex-1 truncate">
                          {title(tab)}
                        </span>
                        {active === tab.id && <Check />}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
      {controls && (
        <RailControls
          active={active}
          kinds={kinds}
          onAdd={onAdd}
          onMove={onMove}
          workspaceApi={workspaceApi}
        />
      )}
      <Dialog
        open={rename != null}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t("shell.panel.renameTab")}</DialogTitle>
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (rename?.title.trim()) {
                onRename?.(rename.id, rename.title.trim());
                setRename(null);
              }
            }}
          >
            <Input
              autoFocus
              aria-label={t("shell.panel.renameTab")}
              value={rename?.title ?? ""}
              onChange={(event) =>
                setRename(
                  (value) => value && { ...value, title: event.target.value }
                )
              }
            />
            <Button type="submit" disabled={!rename?.title.trim()}>
              {t("shell.panel.saveTab")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

type RailProps = React.ComponentProps<typeof RailSegment>;

/** `full` with the segment's new order slotted into the places it held. */
export const mergeOrder = (
  full: readonly string[],
  segment: readonly string[]
): string[] => {
  const members = new Set(segment);
  let next = 0;
  return full.map((id) => (members.has(id) ? segment[next++]! : id));
};

/**
 * The title bar's tab strip. Docked into several panes, each pane's tabs sit
 * over that pane and the menus share the right edge; otherwise one strip.
 */
export const TabsRail = ({
  columns,
  ...props
}: RailProps & { columns?: readonly DockColumn[] }) => {
  if (columns && columns.length > 1)
    return <GroupedRail columns={columns} {...props} />;
  return <RailSegment {...props} />;
};

const GroupedRail = ({
  columns,
  ...props
}: RailProps & { columns: readonly DockColumn[] }) => {
  const { tabs, active, onChange, onClose, onReopen, onReorder } = props;
  const root = useRef<HTMLDivElement>(null);
  useTabShortcuts(root, true, { tabs, active, onChange, onClose, onReopen });
  const known = new Set(columns.flatMap((column) => column.ids));
  const orphans = tabs.filter((tab) => !known.has(tab.id));
  const ids = tabs.map((tab) => tab.id);
  return (
    <div
      ref={root}
      data-slot="topbar-panel-tabs-groups"
      className="titlebar-drag mr-2 flex w-full max-w-full min-w-0 flex-1 items-center gap-0 self-stretch"
    >
      {columns.map((column, index) => {
        const last = index === columns.length - 1;
        const members = tabs.filter(
          (tab) =>
            column.ids.includes(tab.id) ||
            (index === 0 && orphans.includes(tab))
        );
        const width = columnStripWidth(columns, index);
        const segmentIds = members.map((tab) => tab.id);
        return (
          <RailSegment
            key={index}
            {...props}
            tabs={members}
            active={
              active && segmentIds.includes(active)
                ? active
                : (column.active ?? segmentIds[0] ?? null)
            }
            kinds={[]}
            controls={false}
            shortcuts={false}
            measureToolbar={false}
            allowTwoRows={false}
            className="mr-0"
            style={
              last ? undefined : { flex: `0 0 ${width}`, width, minWidth: 0 }
            }
            onReorder={(order) => onReorder(mergeOrder(ids, order))}
          />
        );
      })}
      <RailControls
        active={active}
        kinds={props.kinds}
        onAdd={props.onAdd}
        onMove={props.onMove}
        workspaceApi={props.workspaceApi}
      />
    </div>
  );
};
