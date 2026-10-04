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
import {
  ArrowLeft,
  ArrowRight,
  Ellipsis,
  PanelLeft,
  PanelRight,
} from "lucide-react";
import { Fragment, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
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
      "titlebar-nodrag text-muted-foreground hover:text-sidebar-foreground size-7",
      className
    )}
    {...props}
  />
);

const Root = ({ children }: { children: ReactNode }) => (
  <header
    data-slot="topbar"
    className="titlebar-drag text-muted-foreground flex h-(--toolbar-h) min-w-0 items-center gap-0 pr-[max(var(--titlebar-end),var(--pane-inset))] pl-(--titlebar-x) text-[13px] select-none"
  >
    {children}
  </header>
);

/**
 * Back, forward, sidebar toggle and (pinned only) the app name. With a
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
        "flex items-center gap-0.5 pl-2",
        sidebarInLayout
          ? "w-[calc(var(--rail-w)+var(--sidebar-occupied-w)-var(--titlebar-x))] min-w-min flex-none"
          : "flex-none pr-2.5"
      )}
    >
      <BarButton
        label={t(settings ? "settings.backToApp" : "shell.topBar.back")}
        disabled={!settings && !canGoBack}
        onClick={() =>
          settings
            ? void navigate({
                ...shellStore.state.lastLocationOutsideSettings,
                to: shellStore.state.lastLocationOutsideSettings.pathname,
                transition: "settings-out",
              } as Parameters<typeof navigate>[0])
            : router.history.back()
        }
      >
        <ArrowLeft />
      </BarButton>
      <BarButton
        data-history="forward"
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
      {showAppName && (
        <span
          data-slot="topbar-app-name"
          className="text-sidebar-foreground min-w-0 truncate pl-2 font-semibold"
        >
          {t("shell.appName")}
        </span>
      )}
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
            className="flex max-w-full min-w-0 flex-1 items-center gap-2 overflow-hidden empty:hidden [&:not(:empty)+span]:hidden [&>*]:max-w-full [&>*]:min-w-0 [&>button]:shrink"
          />
          <span className="text-sidebar-foreground min-w-0 truncate font-medium">
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

const PanelTabs = ({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly SidePanelTabId[];
  value: SidePanelTabId;
  onChange(tab: SidePanelTabId): void;
}) => {
  const { t } = useTranslation();
  if (tabs.length === 0) return null;
  // Canvas `SplitView`: borderless chips at the bar controls' height, the
  // active one filled; 8 px before the panel toggle (V7).
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next as SidePanelTabId)}
      className="titlebar-nodrag mr-2 shrink-0"
    >
      <TabsList
        data-tour="topbar-panel-tabs"
        aria-label={t("shell.topBar.panelTabs")}
        data-topbar-tabs=""
        className="gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-7"
      >
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab}
            value={tab}
            className="text-muted-foreground hover:text-sidebar-foreground data-active:bg-sidebar-accent data-active:text-sidebar-foreground dark:text-muted-foreground dark:data-active:bg-sidebar-accent dark:data-active:text-sidebar-foreground h-7 flex-none rounded-lg border-0 px-3 shadow-none after:hidden dark:data-active:border-transparent"
          >
            {t(`shell.panel.tabs.${tab}`)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
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
