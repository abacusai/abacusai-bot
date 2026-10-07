import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
  type SerializedDockview,
} from "dockview-react";

import "dockview-react/dist/styles/dockview.css";
import { Ellipsis, X } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";

import { useDb } from "#renderer/data/db";
import { createPaneWidthWriter, usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import {
  clampPanelWidth,
  PANEL_DEFAULT_PX,
  PANEL_MIN_PX,
  panelMaxFor,
} from "#renderer/lib/side-panel/geometry";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
} from "#renderer/ui/dropdown-menu";
import { ResizablePanelGroup, ResizablePanel } from "#renderer/ui/resizable";

import { PanelResizeHandle } from "./resize-handle";

export interface WorkspaceTab {
  id: string;
  title: string;
  content(visible: boolean): ReactNode;
}
interface WorkspaceContext {
  expanded: boolean;
  targets: Map<string, HTMLDivElement>;
  close(id: string): void;
}
const Context = createContext<WorkspaceContext | null>(null);
const Content = ({ api }: IDockviewPanelProps) => {
  const context = use(Context)!;
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = context.targets.get(api.id);
    if (context.expanded && target && container.current)
      container.current.append(target);
  }, [context, api.id]);
  return <div ref={container} className="size-full min-h-0 min-w-0" />;
};
const Tab = ({ api, containerApi }: IDockviewPanelHeaderProps) => {
  const { t } = useTranslation();
  const context = use(Context)!;
  return (
    <div className="flex h-8 min-w-0 items-center gap-1 px-2 text-xs">
      <span className="max-w-40 truncate">{api.title}</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("sessions.dock.move")}
            />
          }
        >
          <Ellipsis className="size-3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuGroup>
            {(["left", "right", "top", "bottom"] as const).map((position) => (
              <DropdownMenuItem
                key={position}
                onClick={() => api.moveTo({ group: api.group, position })}
              >
                {t(`sessions.dock.moveDirections.${position}`)}
              </DropdownMenuItem>
            ))}
            {containerApi.groups
              .filter((group) => group.id !== api.group.id)
              .map((group) => (
                <DropdownMenuItem
                  key={group.id}
                  onClick={() => api.moveTo({ group, position: "center" })}
                >
                  {t("sessions.dock.movePane", {
                    name: group.activePanel?.title ?? group.id,
                  })}
                </DropdownMenuItem>
              ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {api.id !== "chat" ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("sessions.dock.closeTab", { name: api.title })}
          onClick={(event) => {
            event.stopPropagation();
            context.close(api.id);
          }}
        >
          <X className="size-3" />
        </Button>
      ) : null}
    </div>
  );
};
const visiblePanels = (api: DockviewApi): string[] => {
  const hidden = api.groups.length === 1;
  for (const group of api.groups)
    if (group.header.hidden !== hidden) group.header.hidden = hidden;
  return api.groups.flatMap((group) =>
    group.activePanel ? [group.activePanel.id] : []
  );
};
const components = { content: Content };
const LAYOUT_PREFIX = "abacusai-bot:dock-layout:v1:";
export const PANEL_DRAG_TYPE = "application/x-abacus-panel";

/** Stable portal targets preserve chat, editor and terminal state across dock moves. */
export const PanelWorkspace = ({
  scope,
  tabs,
  active,
  open,
  expanded,
  onSelect,
  onClose,
  apiRef,
}: {
  scope: string;
  tabs: WorkspaceTab[];
  active: string | null;
  open: boolean;
  expanded: boolean;
  onSelect(id: string): void;
  onClose(id: string): void;
  apiRef: RefObject<DockviewApi | null>;
}) => {
  const db = useDb();
  const prefs = usePrefs();
  const [targets] = useState(() => new Map<string, HTMLDivElement>());
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const container = useRef<HTMLDivElement>(null);
  const sidePanel = usePanelRef();
  const prefKey = `panel.${scope}`;
  const [writers] = useState(
    () => new Map<string, ReturnType<typeof createPaneWidthWriter>>()
  );
  const writer = writers.get(prefKey) ?? createPaneWidthWriter(db, prefKey);
  writers.set(prefKey, writer);
  const resized = useRef<number | null>(null);
  const save = useEffectEvent((value: SerializedDockview) => {
    if (expanded) {
      try {
        localStorage.setItem(LAYOUT_PREFIX + scope, JSON.stringify(value));
      } catch {
        /* Keep this window’s layout. */
      }
    }
  });
  const select = useEffectEvent(onSelect);
  for (const tab of tabs)
    if (!targets.has(tab.id)) {
      const target = document.createElement("div");
      target.className = "size-full min-h-0 min-w-0";
      target.dataset.dockPane = tab.id;
      targets.set(tab.id, target);
    }
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => writer.flush(), [writer]);
  const synchronize = useEffectEvent(() => {
    if (!api) return;
    const ids = tabs.map((tab) => tab.id);
    for (const panel of api.panels)
      if (!ids.includes(panel.id)) api.removePanel(panel);
    for (const tab of tabs) {
      const panel = api.getPanel(tab.id);
      if (panel) {
        if (panel.title !== tab.title) panel.api.setTitle(tab.title);
      } else
        api.addPanel({
          id: tab.id,
          title: tab.title,
          component: "content",
          renderer: "always",
          inactive: true,
          minimumWidth: tab.id === "chat" ? 360 : 280,
          minimumHeight: 180,
          ...(api.panels.length
            ? {
                position: {
                  referencePanel: api.panels[0]!.id,
                  direction: "within" as const,
                },
              }
            : {}),
        });
    }
    queueMicrotask(() => setVisible(visiblePanels(api)));
  });
  useEffect(() => {
    if (!api) return;
    apiRef.current = api;
    api.clear();
    try {
      const raw = localStorage.getItem(LAYOUT_PREFIX + scope);
      if (raw) {
        const layout = JSON.parse(raw) as SerializedDockview;
        for (const panel of Object.values(layout.panels)) {
          panel.minimumWidth = panel.id === "chat" ? 360 : 280;
          panel.minimumHeight = 180;
        }
        api.fromJSON(layout);
      }
    } catch {
      api.clear();
    }
    synchronize();
    const subscriptions = [
      api.onDidLayoutChange(() => {
        setVisible(visiblePanels(api));
        save(api.toJSON());
      }),
      api.onDidActivePanelChange(({ panel, origin }) => {
        if (origin === "user" && panel) select(panel.id);
        setVisible(visiblePanels(api));
      }),
      api.onUnhandledDragOver((event) => {
        if (
          event.nativeEvent instanceof DragEvent &&
          event.nativeEvent.dataTransfer?.types.includes(PANEL_DRAG_TYPE)
        )
          event.accept();
      }),
      api.onDidDrop((event) => {
        if (!(event.nativeEvent instanceof DragEvent)) return;
        const ref = event.nativeEvent.dataTransfer?.getData(PANEL_DRAG_TYPE);
        if (ref)
          api
            .getPanel(ref)
            ?.api.moveTo({ group: event.group, position: event.position });
      }),
    ];
    return () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      apiRef.current = null;
    };
  }, [api, scope, apiRef]);
  const signature = JSON.stringify(tabs.map((tab) => [tab.id, tab.title]));
  useEffect(() => {
    synchronize();
  }, [api, signature]);
  useEffect(() => {
    if (expanded && active) api?.getPanel(active)?.api.setActive();
  }, [api, active, expanded]);
  const split = open && !expanded && width >= 728;
  const maximum = panelMaxFor(width);
  const stored = clampPanelWidth(
    prefs.panes[prefKey] ?? prefs.panes["side-panel"] ?? PANEL_DEFAULT_PX,
    maximum
  );
  useLayoutEffect(() => {
    if (split) sidePanel.current?.resize(stored);
  }, [split, stored, sidePanel]);
  const attach = (id: string, element: HTMLDivElement | null) => {
    const target = targets.get(id);
    if (!expanded && target && element) element.append(target);
  };
  return (
    <Context value={{ expanded, targets, close: onClose }}>
      <div
        ref={container}
        data-slot="panel-workspace"
        className="relative size-full min-h-0 min-w-0"
      >
        <div
          hidden={expanded}
          className={cn("size-full", expanded && "hidden")}
        >
          <ResizablePanelGroup
            orientation="horizontal"
            className="gap-0"
            onLayoutChanged={(_, meta) => {
              if (split && meta.isUserInteraction && resized.current != null)
                writer.write(clampPanelWidth(resized.current, maximum));
            }}
          >
            <ResizablePanel
              data-workspace-pane="chat"
              id="pane"
              minSize={split ? 360 : 0}
            >
              <div
                ref={(element) => attach("chat", element)}
                className={cn("size-full", open && !split && "hidden")}
              />
            </ResizablePanel>
            {split ? (
              <PanelResizeHandle
                onReset={() => {
                  sidePanel.current?.resize(PANEL_DEFAULT_PX);
                  writer.write(PANEL_DEFAULT_PX);
                }}
              />
            ) : null}
            <ResizablePanel
              id="side-panel"
              data-workspace-pane="tools"
              panelRef={sidePanel}
              minSize={split ? PANEL_MIN_PX : 0}
              maxSize={!open ? 0 : split ? maximum : undefined}
              defaultSize={open ? stored : 0}
              onResize={(size) => {
                resized.current = size.inPixels;
              }}
            >
              {tabs
                .filter((tab) => tab.id !== "chat")
                .map((tab) => (
                  <div
                    key={tab.id}
                    ref={(element) => attach(tab.id, element)}
                    className={cn(
                      "size-full min-h-0 min-w-0",
                      (!open || tab.id !== active) && "hidden"
                    )}
                  />
                ))}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        <div
          hidden={!expanded}
          className={cn(
            "panel-dock size-full",
            visible.length === 1 && "single-group",
            !expanded && "hidden"
          )}
        >
          {tabs.length > 1 || api ? (
            <DockviewReact
              className="size-full"
              theme={themeDark}
              components={components}
              defaultTabComponent={Tab}
              disableFloatingGroups
              onReady={({ api: ready }) => setApi(ready)}
            />
          ) : null}
        </div>
        {tabs.map((tab) =>
          createPortal(
            tab.content(
              expanded
                ? visible.includes(tab.id)
                : tab.id === "chat"
                  ? !open || split
                  : open && active === tab.id
            ),
            targets.get(tab.id)!,
            `${scope}:${tab.id}`
          )
        )}
      </div>
    </Context>
  );
};
