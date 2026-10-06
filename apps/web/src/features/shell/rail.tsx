/**
 * The rail (spec 01 §7.2, canvas `Rail`): 56 px; Bots, Sessions, Routines,
 * Artifacts, Library on top, Settings and Account at the bottom. Items stack
 * on a 48 px pitch (V5). Each item goes to the area's last visited route
 * location (pathname + search; for a masked pop-up, the background it
 * showed). Hovering the rail while the sidebar floats opens it after 120 ms
 * of intent; the shell cancels that timer on navigation and unmount.
 */
import { useStore } from "@tanstack/react-store";
import type { PointerEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon, type AppIconName } from "#renderer/components/app-icon";
import { cn } from "#renderer/lib/cn";
import type { NavType } from "#renderer/lib/motion";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { AREA_HOME, RAIL_AREAS } from "#renderer/lib/navigation/areas";
import { Avatar, AvatarFallback } from "#renderer/ui/avatar";

import { useFloatingIntent } from "./floating-intent";
import type { ShellArea } from "./layout";
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

const RailLink = ({
  area,
  target,
  transition,
  onPointerEnter,
  ...props
}: {
  area: ShellArea;
  target: AreaLocation;
  transition: NavType;
  onPointerEnter?: (event: PointerEvent<HTMLAnchorElement>) => void;
  className?: string;
  children?: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
  title?: string;
  "data-area"?: string;
  "data-tour"?: string;
}) => (
  <AppLink
    {...(props as object)}
    onPointerEnter={(event) => {
      preloadSidebar(area);
      onPointerEnter?.(event);
    }}
    onFocus={() => preloadSidebar(area)}
    to={target.pathname as never}
    search={target.search as never}
    transition={transition}
  />
);

const RailItem = ({
  area,
  active,
  icon,
  label,
  target,
  onPreview,
}: {
  area: ShellArea;
  active: boolean;
  icon: AppIconName;
  label: string;
  target: AreaLocation;
  /** A mouse over the item: the floating sidebar switches to this area. */
  onPreview?: (area: ShellArea) => void;
}) => (
  <RailLink
    area={area}
    target={target}
    onPointerEnter={(event) => {
      if (event.pointerType === "mouse") onPreview?.(area);
    }}
    transition={area === "settings" ? "settings-in" : "nav-lateral"}
    aria-current={active ? "page" : undefined}
    data-area={area}
    data-tour={
      area === "artifacts"
        ? "rail-artifacts"
        : area === "library"
          ? "rail-library"
          : undefined
    }
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
    <span>{label}</span>
  </RailLink>
);

export const Rail = ({
  area,
  floatingEnabled,
  initials,
  label,
}: {
  area: ShellArea | undefined;
  /** Overrides the landmark name (the gallery shows several rails). */
  label?: string;
  /** The sidebar is not pinned: hovering opens it floating. */
  floatingEnabled: boolean;
  initials: string;
}) => {
  const { t } = useTranslation();
  const last = useStore(shellStore, (state) => state.lastLocationByArea);
  const intent = useFloatingIntent();

  return (
    <nav
      aria-label={label ?? t("shell.rail.label")}
      data-slot="rail"
      data-tour="rail-bots-sessions"
      className="flex w-(--rail-w) shrink-0 flex-col items-center pt-1 pb-3"
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
          onPreview={floatingEnabled ? previewFloatingArea : undefined}
        />
      ))}
      <div className="flex-1" />
      <RailLink
        area="settings"
        target={railTarget("settings", last)}
        transition="settings-in"
        aria-label={t("shell.rail.settings")}
        title={t("shell.rail.settings")}
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
      <AppLink
        to="/settings/account"
        transition="settings-in"
        aria-label={t("shell.rail.account")}
        title={t("shell.rail.account")}
        className="titlebar-nodrag focus-visible:ring-ring/50 mt-2 rounded-full outline-none focus-visible:ring-2"
      >
        <Avatar size="sm">
          <AvatarFallback className="text-foreground text-[11px] font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </AppLink>
    </nav>
  );
};
