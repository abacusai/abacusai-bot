/**
 * Everything `__root` mounts around the routes (spec 01 §6.1): collections,
 * hotkeys with the platform from `system.info`, tooltips, the registry
 * Toaster, the icon sprite, the theme/chrome/readiness/invalidation effects,
 * the occlusion watcher, the app's shortcut handler and the command menu.
 */
import { useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";

import { AppIconSprite } from "#next/components/app-icon";
import { DbProvider, type Db } from "#next/data/db";
import { useInvalidationBridge } from "#next/data/queries/invalidation";
import type { Transport } from "#next/data/transport";
import { inertWhileHidden } from "#next/lib/inert-hidden";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { toHotkeyPlatform } from "#next/lib/platform";
import { ThemeEffect } from "#next/lib/theme-effect";
import {
  ChromeEffect,
  useChromeState,
} from "#next/lib/window-chrome/chrome-state";
import { TooltipProvider } from "#next/ui/tooltip";
import type { SystemInfo } from "#shared/contract";

import { AppToaster } from "./app-toaster";
import { CommandMenu } from "./command-menu";
import { AppHotkeys, AppHotkeysProvider, type ShellActions } from "./hotkeys";
import { NotificationClicks } from "./notification-clicks";
import { createOcclusionWatcher } from "./occlusion";
import { ReadinessReporter } from "./readiness";
import {
  closeFloating,
  setCommandOpen,
  setOcclusion,
  shellStore,
} from "./shell-store";
import { usePanel } from "./use-panel";
import { useShellMatch } from "./use-shell-match";
import { useSidebarToggle } from "./use-sidebar-toggle";

const InvalidationBridge = ({ transport }: { transport: Transport }): null => {
  useInvalidationBridge(transport);
  return null;
};

/**
 * `html[data-platform]`: where the window's vibrancy (macOS) or mica
 * (Windows) sits behind a transparent chrome (tokens.css, V1).
 */
const PlatformEffect = ({ platform }: { platform: string }): null => {
  useEffect(() => {
    document.documentElement.dataset.platform = platform;
  }, [platform]);
  return null;
};

const InertHiddenEffect = (): null => {
  useEffect(() => inertWhileHidden(), []);
  return null;
};

const OcclusionEffect = (): null => {
  useEffect(() => {
    const watcher = createOcclusionWatcher({ publish: setOcclusion });
    return () => watcher.dispose();
  }, []);
  return null;
};

/** What the app shortcuts do, from wherever the user is. */
const useShellActions = (): ShellActions => {
  const navigate = useAppNavigate();
  const { area } = useShellMatch();
  const panel = usePanel(area);
  const sidebar = useSidebarToggle();
  const floatingOpen = useStore(shellStore, (state) => state.floating.open);

  return {
    floatingOpen,
    openCommand: () => setCommandOpen(true),
    newInArea: () => {
      const href =
        area === "bots"
          ? "/bots/new"
          : area === "routines"
            ? "/routines/new"
            : "/sessions/new";
      void navigate({
        href,
        transition: area === "routines" ? "none" : "nav-lateral",
      } as never);
    },
    togglePinned: sidebar.toggle,
    // Reopens the tab last shown in this area (§7.9).
    togglePanel: panel.toggle,
    openSettings: () =>
      void navigate({
        href: "/settings/general",
        transition: "settings-in",
      } as never),
    closeFloating,
  };
};

const ShortcutHandler = () => {
  const actions = useShellActions();
  return <AppHotkeys actions={actions} />;
};

export const AppRoot = ({
  transport,
  db,
  system,
  children,
}: {
  transport: Transport;
  db: Db;
  system: SystemInfo;
  children: ReactNode;
}) => {
  const chrome = useChromeState(transport);
  return (
    <DbProvider value={db}>
      <AppHotkeysProvider platform={toHotkeyPlatform(system.platform)}>
        <TooltipProvider>
          <AppToaster toolbarHeight={chrome.toolbarHeight}>
            <AppIconSprite />
            <ThemeEffect />
            <PlatformEffect platform={system.platform} />
            <ChromeEffect transport={transport} />
            <ReadinessReporter
              transport={transport}
              collections={db.collections}
            />
            <InvalidationBridge transport={transport} />
            <NotificationClicks transport={transport} />
            <OcclusionEffect />
            <InertHiddenEffect />
            <ShortcutHandler />
            <CommandMenu />
            {children}
          </AppToaster>
        </TooltipProvider>
      </AppHotkeysProvider>
    </DbProvider>
  );
};
