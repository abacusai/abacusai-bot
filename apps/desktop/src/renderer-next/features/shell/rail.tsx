/**
 * The rail (spec 01 §7.2, canvas `Rail`): 56 px; Bots, Sessions, Routines,
 * Artifacts, Library on top, Settings and Account at the bottom. Each item
 * goes to the area's last visited location. Hovering the rail while the
 * sidebar is not pinned opens the floating sidebar after 120 ms of intent.
 */
import { useStore } from "@tanstack/react-store";
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { AppIcon, type AppIconName } from "#next/components/app-icon";
import { cn } from "#next/lib/cn";
import { AppLink } from "#next/lib/navigation/app-link";
import { AREA_HOME, RAIL_AREAS } from "#next/lib/navigation/areas";
import { Avatar, AvatarFallback } from "#next/ui/avatar";

import type { ShellArea } from "./layout";
import {
  cancelCloseFloating,
  openFloating,
  scheduleCloseFloating,
  shellStore,
} from "./shell-store";

export const HOVER_INTENT_MS = 120;

const RailItem = ({
  area,
  active,
  icon,
  label,
  href,
}: {
  area: ShellArea;
  active: boolean;
  icon: AppIconName;
  label: string;
  href: string;
}) => (
  <AppLink
    to={href}
    transition={area === "settings" ? "settings-in" : "nav-lateral"}
    aria-current={active ? "page" : undefined}
    data-area={area}
    className={cn(
      "titlebar-nodrag group/rail focus-visible:ring-ring/50 flex size-12 flex-col items-center justify-center gap-[3px] rounded-lg text-[10px] font-medium outline-none focus-visible:ring-2",
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
  </AppLink>
);

export const Rail = ({
  area,
  floatingEnabled,
  initials,
}: {
  area: ShellArea | undefined;
  /** The sidebar is not pinned: hovering opens it floating. */
  floatingEnabled: boolean;
  initials: string;
}) => {
  const { t } = useTranslation();
  const last = useStore(shellStore, (state) => state.lastLocationByArea);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = (): void => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
  };

  return (
    <nav
      aria-label={t("shell.rail.label")}
      data-slot="rail"
      className="flex w-(--rail-w) shrink-0 flex-col items-center gap-1 pt-1 pb-3"
      onPointerEnter={() => {
        if (!floatingEnabled) return;
        clear();
        cancelCloseFloating();
        timer.current = setTimeout(
          () => openFloating("hover"),
          HOVER_INTENT_MS
        );
      }}
      onPointerLeave={() => {
        clear();
        // Moving onto the floating sidebar cancels this.
        if (floatingEnabled) scheduleCloseFloating();
      }}
    >
      {RAIL_AREAS.map((item) => (
        <RailItem
          key={item}
          area={item}
          active={area === item}
          icon={item}
          label={t(`shell.rail.${item}`)}
          href={last[item] ?? AREA_HOME[item]}
        />
      ))}
      <div className="flex-1" />
      <AppLink
        to={last.settings ?? AREA_HOME.settings}
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
      </AppLink>
      <AppLink
        to="/settings/account"
        transition="settings-in"
        aria-label={t("shell.rail.account")}
        title={t("shell.rail.account")}
        className="titlebar-nodrag focus-visible:ring-ring/50 mt-1.5 rounded-full outline-none focus-visible:ring-2"
      >
        <Avatar size="sm">
          <AvatarFallback className="text-[11px] font-semibold">
            {initials}
          </AvatarFallback>
        </Avatar>
      </AppLink>
    </nav>
  );
};
