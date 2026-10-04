/**
 * The app's only keyboard handler for app shortcuts (spec 01 §7.9). Every
 * binding is exact (`Mod+Alt+B` never fires `Mod+B`); the platform comes once
 * from `HotkeysProvider` (`toHotkeyPlatform(system.info.platform)`).
 *
 * The provider defaults turn the library's own preventDefault/stopPropagation
 * off, because it cancels *before* the callback: `useAppHotkey` decides, so a
 * rich-text target keeps native Mod+B (bold) when `guardRichText` is set.
 */
import { formatForDisplay, HotkeysProvider } from "@tanstack/react-hotkeys";
import type { ReactNode } from "react";

import { dispatchHotkeyAction, useAppHotkey } from "#renderer/lib/hotkeys";
import type { HotkeyPlatform } from "#renderer/lib/platform";

export const APP_HOTKEYS = {
  command: "Mod+K",
  new: "Mod+N",
  toggleSidebar: "Mod+B",
  togglePanel: "Mod+Alt+B",
  settings: "Mod+,",
  escape: "Escape",
  closeTab: "Mod+W",
  nextTab: "Control+Tab",
  previousTab: "Control+Shift+Tab",
} as const;

export const AppHotkeysProvider = ({
  platform,
  children,
}: {
  platform: HotkeyPlatform;
  children: ReactNode;
}) => (
  <HotkeysProvider
    defaultOptions={{
      hotkey: { platform, preventDefault: false, stopPropagation: false },
    }}
  >
    {children}
  </HotkeysProvider>
);

/** Re-exported: the one registration path for app shortcuts (§7.9). */
export { useAppHotkey };
export const dispatchAppHotkey = (
  id: keyof typeof APP_HOTKEYS | "newTerminalTab"
): void =>
  dispatchHotkeyAction(
    {
      command: "command-menu",
      new: "new-in-area",
      toggleSidebar: "toggle-sidebar",
      togglePanel: "toggle-side-panel",
      settings: "open-settings",
      escape: APP_HOTKEYS.escape,
      closeTab: "close-tab",
      nextTab: "next-tab",
      previousTab: "previous-tab",
      newTerminalTab: "new-terminal-tab",
    }[id]
  );

export interface ShellActions {
  openCommand(): void;
  newInArea(): void;
  newBot?(): void;
  togglePinned(): void;
  togglePanel(): void;
  openSettings(): void;
  closeFloating(): void;
  floatingOpen: boolean;
}

export const AppHotkeys = ({
  actions,
  bindings = {},
}: {
  actions: ShellActions;
  bindings?: Record<string, string | null>;
}): null => {
  const binding = (id: string, fallback: string) =>
    Object.hasOwn(bindings, id) ? bindings[id]! : fallback;
  useAppHotkey(
    binding("command-menu", APP_HOTKEYS.command),
    actions.openCommand,
    { actionId: "command-menu" }
  );
  useAppHotkey(binding("new-bot", "Mod+Shift+N"), () => actions.newBot?.(), {
    enabled: !!actions.newBot,
    actionId: "new-bot",
  });
  useAppHotkey(binding("new-in-area", APP_HOTKEYS.new), actions.newInArea, {
    actionId: "new-in-area",
  });
  useAppHotkey(
    binding("toggle-sidebar", APP_HOTKEYS.toggleSidebar),
    actions.togglePinned,
    {
      guardRichText: true,
      actionId: "toggle-sidebar",
    }
  );
  useAppHotkey(
    binding("toggle-side-panel", APP_HOTKEYS.togglePanel),
    actions.togglePanel,
    {
      guardRichText: true,
      actionId: "toggle-side-panel",
    }
  );
  useAppHotkey(
    binding("open-settings", APP_HOTKEYS.settings),
    actions.openSettings,
    { actionId: "open-settings" }
  );
  useAppHotkey(APP_HOTKEYS.escape, actions.closeFloating, {
    enabled: actions.floatingOpen,
  });
  return null;
};

/** ⌘ on macOS, Ctrl elsewhere. */
export const hotkeyLabel = (
  binding: string,
  platform: HotkeyPlatform
): string => formatForDisplay(binding as never, { platform });
