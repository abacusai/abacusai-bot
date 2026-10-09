/**
 * The rail (spec 01 §7.2, canvas `Rail`): 56 px; Bots, Sessions, Routines,
 * Artifacts, Library on top, Settings and Account at the bottom. Items stack
 * on a 48 px pitch (V5). Each item goes to the area's last visited route
 * location (pathname + search; for a masked pop-up, the background it
 * showed). Hovering the rail while the sidebar floats opens it after 120 ms
 * of intent; the shell cancels that timer on navigation and unmount.
 *
 * `iconsOnly` (Settings › Appearance) drops the labels; each item then
 * names itself in a tooltip to the right, with its shortcut, except while
 * the sidebar floats: there a hover opens the floating sidebar for the
 * area, and a tooltip would fight it.
 */
import { formatForDisplay } from "@tanstack/hotkeys";
import { useStore } from "@tanstack/react-store";
import type { FocusEvent, PointerEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { RailUpdatePill } from "#platform/updates";
import { AppIcon, type AppIconName } from "#renderer/components/app-icon";
import { openStartDraft } from "#renderer/features/sessions/start/start-session";
import { cn } from "#renderer/lib/cn";
import type { NavType } from "#renderer/lib/motion";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { AREA_HOME, RAIL_AREAS } from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { uiPlatform } from "#renderer/lib/platform";
import { useSystem } from "#renderer/lib/use-app-context";
import { Kbd } from "#renderer/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { AgentLink } from "./agent-link";
import { useFloatingIntent } from "./floating-intent";
import { APP_HOTKEYS } from "./hotkeys";
import type { ShellArea } from "./layout";
import { ProfileMenu } from "./profile-menu";
import {
  previewFloatingArea,
  shellStore,
  type AreaLocation,
} from "./shell-store";
import { preloadSidebar } from "./sidebars";

/** Where the rail sends an area: its last location, else its home. */
const railTarget = (
  area: ShellArea,
  last: Partial<Record<ShellArea, AreaLocation>>
): AreaLocation => last[area] ?? { pathname: AREA_HOME[area], search: {} };

/** Tooltips wait a beat so a pass over the rail shows none. */
const TOOLTIP_DELAY_MS = 400;

const RailLink = ({
  area,
  target,
  transition,
  onPointerEnter,
  onFocus,
  ...props
}: {
  area: ShellArea;
  target: AreaLocation;
  transition: NavType;
  onPointerEnter?: (event: PointerEvent<HTMLAnchorElement>) => void;
  onFocus?: (event: FocusEvent<HTMLAnchorElement>) => void;
  className?: string;
  children?: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
  title?: string;
  "data-area"?: string;
  "data-tour"?: string;
  "data-tour-target"?: string;
}) => {
  const navigate = useAppNavigate();
  return (
    <AppLink
      {...(props as object)}
      onPointerEnter={(event) => {
        preloadSidebar(area);
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        preloadSidebar(area);
        onFocus?.(event);
      }}
      onClick={(event) => {
        if (
          area === "sessions" &&
          target.pathname === "/sessions/new" &&
          !event.metaKey &&
          !event.ctrlKey &&
          !event.shiftKey &&
          event.button === 0
        ) {
          event.preventDefault();
          void navigate({
            to: "/sessions/new",
            search: { draft: openStartDraft() },
            transition,
          });
        }
      }}
      to={target.pathname as never}
      search={target.search as never}
      transition={transition}
    />
  );
};

/**
 * The item's name (and shortcut) to its right, only when the labels are
 * off and the sidebar is in layout; otherwise the link as it is.
 */
const RailTip = ({
  label,
  shortcut,
  enabled,
  children,
}: {
  label: string;
  shortcut?: string;
  enabled: boolean;
  children: React.ReactElement;
}) => {
  if (!enabled) return children;
  return (
    <Tooltip>
      <TooltipTrigger delay={TOOLTIP_DELAY_MS} render={children} />
      <TooltipContent side="right" sideOffset={6}>
        {label}
        {shortcut != null && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
};

const RailItem = ({
  area,
  active,
  icon,
  label,
  target,
  iconsOnly,
  tooltip,
  onPreview,
}: {
  area: ShellArea;
  active: boolean;
  icon: AppIconName;
  label: string;
  target: AreaLocation;
  iconsOnly: boolean;
  tooltip: boolean;
  /** A mouse over the item: the floating sidebar switches to this area. */
  onPreview?: (area: ShellArea) => void;
}) => (
  <RailTip label={label} enabled={tooltip}>
    <RailLink
      area={area}
      target={target}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onPreview?.(area);
      }}
      transition={area === "settings" ? "settings-in" : "nav-lateral"}
      aria-current={active ? "page" : undefined}
      aria-label={iconsOnly ? label : undefined}
      data-area={area}
      data-tour-target={area}
      className={cn(
        "titlebar-nodrag group/rail focus-visible:ring-ring/50 flex size-(--rail-item) shrink-0 flex-col items-center justify-center gap-[3px] rounded-lg text-[10px] font-medium outline-none focus-visible:ring-2",
        active
          ? "text-sidebar-foreground"
          : "text-muted-foreground hover:text-sidebar-foreground"
      )}
    >
      <span
        className={cn(
          "flex h-[30px] w-9 items-center justify-center rounded-[10px] transition-colors",
          active ? "bg-sidebar-accent" : "group-hover/rail:bg-sidebar-accent/50"
        )}
      >
        <AppIcon name={icon} size={20} />
      </span>
      {!iconsOnly && (
        // One line, never two: the label may use the whole 56 px column
        // (the item is 48), and one the column cannot hold is cut; the
        // link's accessible name is its text, so `title` carries the rest.
        <span
          title={label}
          className="max-w-(--rail-w) truncate leading-none tracking-[-0.01em] whitespace-nowrap"
        >
          {label}
        </span>
      )}
    </RailLink>
  </RailTip>
);

export const Rail = ({
  area,
  floatingEnabled,
  iconsOnly = false,
  label,
}: {
  area: ShellArea | undefined;
  /** Overrides the landmark name (the gallery shows several rails). */
  label?: string;
  /** The sidebar is not pinned: hovering opens it floating. */
  floatingEnabled: boolean;
  /** Settings › Appearance "Rail: icons only". */
  iconsOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const system = useSystem();
  const last = useStore(shellStore, (state) => state.lastLocationByArea);
  const intent = useFloatingIntent();
  // While the sidebar floats, a hover opens it for the area: no tooltips.
  const tooltip = iconsOnly && !floatingEnabled;

  return (
    <nav
      aria-label={label ?? t("shell.rail.label")}
      data-slot="rail"

      data-icons-only={iconsOnly ? "" : undefined}
      className="scroll-fade-y flex min-h-0 w-(--rail-w) shrink-0 flex-col items-center overflow-y-auto pt-1 pb-3"
      // Hover intent is a mouse gesture: a tap navigates and never opens or
      // closes the floating sidebar (the title-bar toggle does on a phone).
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse") return;
        if (floatingEnabled) intent.hover();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "mouse") return;
        // Moving onto the floating sidebar holds it open.
        if (floatingEnabled) intent.leave();
        else intent.cancel();
      }}
    >
      {RAIL_AREAS.map((item) => (
        <RailItem
          key={item}
          area={item}
          active={area === item}
          icon={item}
          label={t(`shell.rail.${item}`)}
          target={railTarget(item, last)}
          iconsOnly={iconsOnly}
          tooltip={tooltip}
          onPreview={floatingEnabled ? previewFloatingArea : undefined}
        />
      ))}
      <div className="flex-1" />
      <div className="flex h-9 shrink-0 items-center justify-center">
        <AgentLink />
      </div>
      <RailUpdatePill />
      <RailTip
        label={t("shell.rail.settings")}
        shortcut={formatForDisplay(APP_HOTKEYS.settings, {
          platform: uiPlatform(system.platform),
        })}
        enabled={tooltip}
      >
        <RailLink
          area="settings"
          data-tour-target="settings"
          target={railTarget("settings", last)}
          transition="settings-in"
          aria-label={t("shell.rail.settings")}
          // The tooltip names it; otherwise the native one does.
          title={tooltip ? undefined : t("shell.rail.settings")}
          aria-current={area === "settings" ? "page" : undefined}
          className={cn(
            "titlebar-nodrag focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-[10px] outline-none focus-visible:ring-2",
            area === "settings"
              ? "bg-sidebar-accent text-sidebar-foreground"
              : "text-muted-foreground hover:text-sidebar-foreground"
          )}
        >
          <AppIcon name="settings" size={18} />
        </RailLink>
      </RailTip>
      <div className="mt-2 shrink-0">
        <ProfileMenu />
      </div>
    </nav>
  );
};
