import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type IDockviewPanelProps,
  type SerializedDockview,
} from "dockview-react";

import "dockview-react/dist/styles/dockview.css";
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
import { usePanelRef } from "react-resizable-panels";

import { useDb } from "#renderer/data/db";
import { createPaneWidthWriter, usePrefs } from "#renderer/data/db/prefs";
import { cn } from "#renderer/lib/cn";
import {
  clampPanelWidth,
  PANEL_DEFAULT_PX,
  PANEL_MIN_PX,
  SPLIT_MIN_PX,
  panelMaxFor,
} from "#renderer/lib/side-panel/geometry";
import { ResizablePanelGroup, ResizablePanel } from "#renderer/ui/resizable";

import { PanelResizeHandle } from "./resize-handle";
import { enhanceDockSplitters } from "./splitters";

export interface WorkspaceTab {
  id: string;
  title: string;
  content(visible: boolean): ReactNode;
}
interface WorkspaceContext {
  expanded: boolean;
  visible: string[];
  targets: Map<string, HTMLDivElement>;
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
  const grouped = context.expanded && context.visible.length > 1;
  return (
    <div
      className={cn(
        "flex size-full min-h-0 min-w-0 flex-col",
        grouped && "workspace-island dock-group-island"
      )}
    >
      <div ref={container} className="min-h-0 min-w-0 flex-1" />
    </div>
  );
};
const visiblePanels = (api: DockviewApi): string[] => {
  for (const group of api.groups)
    if (!group.header.hidden) group.header.hidden = true;
  return api.groups.flatMap((group) =>
    group.activePanel ? [group.activePanel.id] : []
  );
};
const retainVisible = (previous: string[], next: string[]) =>
  previous.length === next.length && previous.every((id, i) => id === next[i])
    ? previous
    : next;
const components = { content: Content };
const LAYOUT_PREFIX = "abacusai-bot:dock-layout:v1:";
export const moveDockTab = (
  api: DockviewApi | null,
  id: string,
  position: "left" | "right" | "top" | "bottom"
) => {
  const panel = api?.getPanel(id);
  if (!api || !panel) return;
  const reference =
    panel.group.panels.length > 1
      ? panel.group
      : (api.groups.find((group) => group !== panel.group) ?? panel.group);
  panel.api.moveTo({ group: reference, position });
};
export const PANEL_DRAG_TYPE = "application/x-abacus-panel";

/** Stable portal targets preserve chat, editor and terminal state across dock moves. */
export const PanelWorkspace = ({
  scope,
  tabs,
  active,
  open,
  expanded,
  onSelect,
  apiRef,
}: {
  scope: string;
  tabs: WorkspaceTab[];
  active: string | null;
  open: boolean;
  expanded: boolean;
  onSelect(id: string): void;
  apiRef: RefObject<DockviewApi | null>;
}) => {
  const db = useDb();
  const prefs = usePrefs();
  const [targets] = useState(() => new Map<string, HTMLDivElement>());
  const [api, setApi] = useState<DockviewApi | null>(null);
  const [visible, setVisible] = useState<string[]>([]);
  const [minimum, setMinimum] = useState({ width: 0, height: 0 });
  const publishLayout = useEffectEvent((dock: DockviewApi) => {
    setVisible((previous) => retainVisible(previous, visiblePanels(dock)));
    setMinimum((previous) =>
      previous.width === dock.minimumWidth &&
      previous.height === dock.minimumHeight
        ? previous
        : { width: dock.minimumWidth, height: dock.minimumHeight }
    );
  });
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const [height, setHeight] = useState(Number.POSITIVE_INFINITY);
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
    if (
      expanded &&
      width >= Math.max(SPLIT_MIN_PX, minimum.width) &&
      height >= minimum.height
    ) {
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
      target.className = "workspace-island size-full min-h-0 min-w-0";
      target.dataset.dockPane = tab.id;
      targets.set(tab.id, target);
    }
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setWidth(entry.contentRect.width);
        setHeight(entry.contentRect.height);
      }
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
    queueMicrotask(() => publishLayout(api));
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
        publishLayout(api);
        save(api.toJSON());
      }),
      api.onDidActivePanelChange(({ panel, origin }) => {
        if (origin === "user" && panel) select(panel.id);
        publishLayout(api);
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
  useEffect(() => {
    if (api && container.current)
      return enhanceDockSplitters(container.current, api);
  }, [api]);
  const signature = JSON.stringify(tabs.map((tab) => [tab.id, tab.title]));
  useEffect(() => {
    synchronize();
  }, [api, signature]);
  useEffect(() => {
    if (expanded && active) api?.getPanel(active)?.api.setActive();
  }, [api, active, expanded]);
  const docked =
    expanded &&
    width >= Math.max(SPLIT_MIN_PX, minimum.width) &&
    height >= minimum.height;
  const showTool = open && active != null && active !== "chat";
  const split = showTool && !expanded && width >= SPLIT_MIN_PX;
  const folded = showTool && !split && !docked;
  const maximum = panelMaxFor(width);
  const stored = clampPanelWidth(
    prefs.panes[prefKey] ?? prefs.panes["side-panel"] ?? PANEL_DEFAULT_PX,
    maximum
  );
  useLayoutEffect(() => {
    if (split) sidePanel.current?.resize(stored);
    else if (folded) sidePanel.current?.resize("100%");
  }, [split, folded, stored, sidePanel]);
  const attach = (id: string, element: HTMLDivElement | null) => {
    const target = targets.get(id);
    if (!docked && target && element) element.append(target);
  };
  return (
    <Context
      value={{
        expanded: docked,
        visible,
        targets,
      }}
    >
      <div
        ref={container}
        data-slot="panel-workspace"
        data-workspace-expanded={docked ? "" : undefined}
        className="relative size-full min-h-0 min-w-0"
      >
        <div hidden={docked} className={cn("size-full", docked && "hidden")}>
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
              maxSize={folded ? 0 : undefined}
            >
              <div
                ref={(element) => attach("chat", element)}
                className={cn("size-full", folded && "hidden")}
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
              maxSize={!showTool ? 0 : split ? maximum : undefined}
              defaultSize={showTool ? (folded ? "100%" : stored) : 0}
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
          hidden={!docked}
          className={cn(
            "panel-dock size-full",
            visible.length === 1 && "single-group",
            !docked && "hidden"
          )}
        >
          {tabs.length > 1 || api ? (
            <DockviewReact
              className="size-full"
              theme={themeDark}
              components={components}
              disableFloatingGroups
              onReady={({ api: ready }) => setApi(ready)}
            />
          ) : null}
        </div>
        {tabs.map((tab) =>
          createPortal(
            tab.content(
              docked
                ? visible.includes(tab.id)
                : tab.id === "chat"
                  ? !folded
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
