import type { SystemInfo } from "@abacus-ai/contract/contract";
/**
 * Everything `__root` mounts around the routes (spec 01 §6.1): collections,
 * hotkeys with the platform from `system.info`, tooltips, the registry
 * Toaster, the icon sprite, the theme/chrome/readiness/invalidation effects,
 * the occlusion watcher, the app's shortcut handler and the command menu.
 */
import { useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";

import { AppIconSprite } from "#renderer/components/app-icon";
import { DbProvider, type Db } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useInvalidationBridge } from "#renderer/data/queries/invalidation";
import type { Transport } from "#renderer/data/transport";
import { ChromeEffect, useChromeState } from "#renderer/lib/chrome-state";
import { inertWhileHidden } from "#renderer/lib/inert-hidden";
import { resolveKeymap } from "#renderer/lib/keyboard/actions";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { uiPlatform } from "#renderer/lib/platform";
import { ThemeEffect } from "#renderer/lib/theme-effect";
import { useAppContext } from "#renderer/lib/use-app-context";
import { TooltipProvider } from "#renderer/ui/tooltip";

import { AppToaster } from "./app-toaster";
import { CommandMenu } from "./command-menu-loader";
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
    newBot: () => {
      void navigate({ to: "/bots/new" });
    },
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
  const prefs = usePrefs();
  const { system } = useAppContext();
  return (
    <AppHotkeys
      actions={actions}
      bindings={resolveKeymap(prefs.keymap, uiPlatform(system.platform)).window}
    />
  );
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
      <AppHotkeysProvider platform={uiPlatform(system.platform)}>
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
            <div className="h-dvh min-h-0 min-w-0 overflow-hidden">
              {children}
            </div>
          </AppToaster>
        </TooltipProvider>
      </AppHotkeysProvider>
    </DbProvider>
  );
};
