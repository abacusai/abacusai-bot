/**
 * Everything `__root` mounts around the routes (spec 01 §6.1): collections,
 * hotkeys with the platform from `system.info`, tooltips, the registry
 * Toaster, the icon sprite, the theme/chrome/readiness effects,
 * the occlusion watcher, the app's shortcut handler and the command menu.
 */
import { useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";

import { HostStatus } from "#platform/connect";
import { AppIconSprite } from "#renderer/components/app-icon";
import { DbProvider, type Db } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";
import { openStartDraft } from "#renderer/features/sessions/start/start-session";
import { ChromeEffect, useChromeState } from "#renderer/lib/chrome-state";
import { dispatchHotkeyAction, hasHotkeyAction } from "#renderer/lib/hotkeys";
import { inertWhileHidden } from "#renderer/lib/inert-hidden";
import { resolveKeymap } from "#renderer/lib/keyboard/actions";
import { LanguageEffect } from "#renderer/lib/language-effect";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { uiPlatform } from "#renderer/lib/platform";
import { ThemeEffect } from "#renderer/lib/theme-effect";
import { useSystem } from "#renderer/lib/use-app-context";
import { TooltipProvider } from "#renderer/ui/tooltip";

import { AppToaster } from "./app-toaster";
import { CommandMenu } from "./command-menu-loader";
import { AppHotkeys, AppHotkeysProvider, type ShellActions } from "./hotkeys";
import { NotificationClicks } from "./notification-clicks";
import { createOcclusionWatcher } from "./occlusion";
import { QuitGuard } from "./quit-guard";
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
  const sidebar = useSidebarToggle(panel);
  const floatingOpen = useStore(shellStore, (state) => state.floating.open);

  return {
    floatingOpen,
    newBot: () => {
      void navigate({ to: "/bots/new" });
    },
    openCommand: () => setCommandOpen(true),
    newInArea: () => {
      const to =
        area === "bots"
          ? "/bots/new"
          : area === "routines"
            ? "/routines/new"
            : "/sessions/new";
      void navigate({
        to,
        ...(to === "/sessions/new"
          ? { search: { draft: openStartDraft() } }
          : {}),
        transition: area === "routines" ? "none" : "nav-lateral",
      });
    },
    // Terminals live in chats: from anywhere else, a new chat opens with
    // one, once its page handles the shortcut itself.
    ...(area !== "sessions"
      ? {
          newTerminalElsewhere: () => {
            void navigate({
              to: "/sessions/new",
              search: { draft: openStartDraft() },
              transition: "nav-lateral",
            });
            let frames = 0;
            const open = () => {
              if (hasHotkeyAction("new-terminal-tab"))
                dispatchHotkeyAction("new-terminal-tab");
              else if (frames++ < 300) requestAnimationFrame(open);
            };
            requestAnimationFrame(open);
          },
        }
      : {}),
    togglePinned: sidebar.toggle,
    // Reopens the tab last shown in this area (§7.9).
    togglePanel: panel.toggle,
    openSettings: () =>
      void navigate({
        to: "/settings/general",
        transition: "settings-in",
      }),
    closeFloating,
  };
};

const ShortcutHandler = () => {
  const actions = useShellActions();
  const prefs = usePrefs();
  const system = useSystem();
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
  children,
}: {
  transport: Transport;
  db: Db;
  children: ReactNode;
}) => {
  const chrome = useChromeState(transport);
  const system = useSystem();
  return (
    <DbProvider value={db}>
      <AppHotkeysProvider platform={uiPlatform(system.platform)}>
        <TooltipProvider>
          <AppToaster toolbarHeight={chrome.toolbarHeight}>
            <AppIconSprite />
            <HostStatus />
            <ThemeEffect />
            <LanguageEffect />
            <PlatformEffect platform={system.platform} />
            <ChromeEffect transport={transport} />
            <ReadinessReporter
              transport={transport}
              collections={db.collections}
            />
            <NotificationClicks transport={transport} db={db} />
            <QuitGuard transport={transport} />
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
