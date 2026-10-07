import type { DockviewApi } from "dockview-react";
import {
  ArrowDownToLine,
  Check,
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
  Plus,
  X,
} from "lucide-react";
import { Reorder, motion, animate } from "motion/react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
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

import { railLayout } from "./layout";
const BarButton = ({
  label,
  ...props
}: { label: string } & ComponentProps<typeof Button>) => (
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label={label}
    title={label}
    className="titlebar-nodrag size-7 shrink-0"
    {...props}
  />
);
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
              : FileText;
const TAB_CLASS =
  "titlebar-nodrag text-muted-foreground hover:text-sidebar-foreground data-active:bg-transparent data-active:text-sidebar-foreground dark:data-active:bg-transparent dark:data-active:text-sidebar-foreground group/tab relative flex h-7 [&>svg]:relative [&>span:not([aria-hidden])]:relative max-w-44 min-w-0 flex-none items-center gap-1 rounded-lg border-0 pr-1.5 pl-3 text-[13px] font-medium shadow-none transition-[background-color,color] duration-150 ease-out select-none data-active:pr-1";

/**
 * The panel's tab strip (canvas `BotChatPanel`, `SplitView`, `TitleMac`):
 * compact tabs with a reachable add button and overflow list. Dockview owns
 * expanded tab dragging; Motion animates rail geometry and the active marker.
 */
export const TabsRail = ({
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
  renderIcon?(tab: PanelTab): ReactNode;
  onReopen?(): void;
  onRename?(id: string, title: string): void;
  workspaceApi?: React.RefObject<DockviewApi | null>;
  onMove?(id: string, position: "left" | "right" | "top" | "bottom"): void;
}) => {
  const { t } = useTranslation();
  const indicator = useId();
  const [rename, setRename] = useState<{ id: string; title: string } | null>(
    null
  );
  const motionPref = useMotionPreference();
  const [moveGroups, setMoveGroups] = useState<{ id: string; title: string }[]>(
    []
  );
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [overflow, setOverflow] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const layout = railLayout(tabs.length, width);
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
    if (!root.current?.closest('[data-slot="topbar"]')) return;
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
  }, [layout.rows, motionPref]);
  useLayoutEffect(() => {
    const titlebar = !!root.current?.closest('[data-slot="topbar"]');
    return () => {
      if (titlebar) {
        const html = document.documentElement;
        html.style.setProperty(
          "--toolbar-h",
          getComputedStyle(html).getPropertyValue("--titlebar-row-h") || "40px"
        );
      }
    };
  }, []);
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
  useEffect(() => {
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
  }, [active, tabs, onChange, onClose, onReopen]);
  if (tabs.length === 0 && kinds.length === 0) return null;
  const ids = tabs.map((tab) => tab.id);
  return (
    <div
      ref={root}
      data-slot="topbar-panel-tabs"
      data-rail-chat={tabs.some((tab) => tab.id === "chat") ? "" : undefined}
      data-rail-mode={layout.mode}
      data-rail-rows={layout.rows}
      className="titlebar-nodrag mr-2 flex w-full max-w-full min-w-0 flex-1 items-center gap-1 self-stretch"
    >
      <Tabs
        value={active ?? undefined}
        onValueChange={(value) => {
          restoreFocus.current =
            list.current?.contains(document.activeElement) ?? false;
          onChange(String(value));
        }}
        className="w-full max-w-full min-w-0"
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
            data-tour="topbar-panel-tabs"
            data-topbar-tabs=""
            className={cn(
              "no-scrollbar flex w-full min-w-0 snap-x items-center gap-1 overflow-x-auto",
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
              return (
                <Reorder.Item
                  key={tab.id}
                  as="div"
                  value={tab.id}
                  layout
                  initial={motionPref === "reduced" ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={
                    motionPref === "reduced"
                      ? reducedTransition
                      : { layout: springs.panel }
                  }
                  whileDrag={{ zIndex: 1 }}
                  dragListener={onDragStart == null}
                  draggable={onDragStart != null}
                  onDragStartCapture={(event) => onDragStart?.(tab.id, event)}
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(
                        "application/x-abacus-panel"
                      )
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const id = event.dataTransfer.getData(
                      "application/x-abacus-panel"
                    );
                    const target = workspaceApi?.current?.getPanel(tab.id);
                    const dragged = workspaceApi?.current?.getPanel(id);
                    if (!target || !dragged || id === tab.id) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const index =
                      id === "chat"
                        ? 0
                        : Math.max(
                            target.group.panels.some(
                              (panel) => panel.id === "chat"
                            )
                              ? 1
                              : 0,
                            target.group.panels.indexOf(target)
                          );
                    dragged.api.moveTo({
                      group: target.group,
                      index,
                      position: "center",
                    });
                    if (ids.includes(id)) {
                      const order = ids.filter((value) => value !== id);
                      order.splice(
                        id === "chat"
                          ? 0
                          : Math.max(
                              order.includes("chat") ? 1 : 0,
                              order.indexOf(tab.id)
                            ),
                        0,
                        id
                      );
                      onReorder(order);
                    }
                  }}
                  className={cn(
                    "min-w-0 snap-start",
                    layout.mode === "scroll"
                      ? "w-28 shrink-0"
                      : layout.mode === "single"
                        ? "max-w-44 flex-1 basis-28"
                        : "flex-1 basis-28"
                  )}
                  style={
                    layout.mode === "single" ? { minWidth: 56 } : undefined
                  }
                >
                  <TabsTrigger
                    value={tab.id}
                    data-active={selected ? "" : undefined}
                    data-panel-tab-id={tab.id}
                    data-panel-tab-kind={tab.kind}
                    title={label}
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
                        (event.key === "Delete" || event.key === "Backspace")
                      ) {
                        event.preventDefault();
                        onClose(tab.id);
                      }
                    }}
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
                    <span
                      className={cn(
                        "min-w-0 truncate",
                        width / tabs.length < 84 &&
                          layout.mode === "single" &&
                          "sr-only"
                      )}
                    >
                      {label}
                    </span>
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
                  </TabsTrigger>
                </Reorder.Item>
              );
            })}
          </Reorder.Group>
        </TabsList>
      </Tabs>
      {overflow && (
        <Popover open={allOpen} onOpenChange={setAllOpen}>
          <PopoverTrigger
            render={<BarButton label={t("shell.topBar.panelTabs")} />}
          >
            <ArrowDownToLine />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="titlebar-nodrag w-56 max-w-[calc(100vw-24px)] gap-0 p-0"
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
