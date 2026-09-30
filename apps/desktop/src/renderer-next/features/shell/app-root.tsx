/**
 * Everything `__root` mounts around the routes (spec 01 §6.1): collections,
 * hotkeys with the platform from `system.info`, tooltips, the registry
 * Toaster, the icon sprite, the theme/chrome/readiness/invalidation effects,
 * the occlusion watcher, the app's shortcut handler and the command menu.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useEffect, type ReactNode } from "react";

import { AppIconSprite } from "#next/components/app-icon";
import { CollectionsProvider, type Collections } from "#next/data/collections";
import { useUpdatePrefs } from "#next/data/collections/prefs";
import { useInvalidationBridge } from "#next/data/queries/invalidation";
import type { Transport } from "#next/data/transport";
import {
  AREA_PANEL_TABS,
  type SidePanelTabId,
} from "#next/lib/navigation/search";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { toHotkeyPlatform } from "#next/lib/platform";
import { ThemeEffect } from "#next/lib/theme-effect";
import { ChromeEffect } from "#next/lib/window-chrome/chrome-state";
import { Toaster } from "#next/ui/toast";
import { TooltipProvider } from "#next/ui/tooltip";
import type { SystemInfo } from "#shared/contract";

import { CommandMenu } from "./command-menu";
import { AppHotkeys, AppHotkeysProvider, type ShellActions } from "./hotkeys";
import { createOcclusionWatcher } from "./occlusion";
import { ReadinessReporter } from "./readiness";
import {
  closeFloating,
  setCommandOpen,
  setOcclusion,
  shellStore,
} from "./shell-store";
import { useShellMatch } from "./use-shell-match";

const InvalidationBridge = ({ transport }: { transport: Transport }): null => {
  useInvalidationBridge(transport);
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
export const useShellActions = (): ShellActions => {
  const navigate = useAppNavigate();
  const plainNavigate = useNavigate();
  const updatePrefs = useUpdatePrefs();
  const { area } = useShellMatch();
  const search = useSearch({ strict: false }) as { tab?: SidePanelTabId };
  const floatingOpen = useStore(shellStore, (state) => state.floating.open);
  const tabs: readonly SidePanelTabId[] =
    area == null ? [] : AREA_PANEL_TABS[area];

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
    togglePinned: () =>
      void updatePrefs((draft) => {
        draft.sidebar = { ...draft.sidebar, pinned: !draft.sidebar.pinned };
      }).catch(() => undefined),
    togglePanel: () => {
      if (area == null) return;
      const next = search.tab == null ? (tabs[0] ?? "details") : undefined;
      void plainNavigate({
        to: ".",
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          tab: next,
        }),
        replace: true,
      } as never);
    },
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
  collections,
  system,
  children,
}: {
  transport: Transport;
  collections: Collections;
  system: SystemInfo;
  children: ReactNode;
}) => (
  <CollectionsProvider value={collections}>
    <AppHotkeysProvider platform={toHotkeyPlatform(system.platform)}>
      <TooltipProvider>
        <Toaster>
          <AppIconSprite />
          <ThemeEffect />
          <ChromeEffect transport={transport} />
          <ReadinessReporter transport={transport} collections={collections} />
          <InvalidationBridge transport={transport} />
          <OcclusionEffect />
          <ShortcutHandler />
          <CommandMenu />
          {children}
        </Toaster>
      </TooltipProvider>
    </AppHotkeysProvider>
  </CollectionsProvider>
);
