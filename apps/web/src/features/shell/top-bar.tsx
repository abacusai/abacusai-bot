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

import { AppBrandMark } from "#renderer/components/app-icon";
import { TabsRail } from "#renderer/components/tabs-rail";
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
    className="titlebar-drag text-muted-foreground phone:pr-1.5 phone:text-[16px] flex min-h-(--toolbar-h) min-w-0 items-center gap-0 pr-[max(var(--titlebar-end),var(--pane-inset))] pl-(--titlebar-x) text-[13px] select-none"
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
  PanelTabs: TabsRail,
  PanelToggle,
  GeometryBadge,
};
