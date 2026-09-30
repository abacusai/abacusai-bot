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

import { dispatchHotkeyAction, useAppHotkey } from "#next/lib/hotkeys";
import type { HotkeyPlatform } from "#next/lib/platform";

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
export const dispatchAppHotkey = (id: keyof typeof APP_HOTKEYS): void =>
  dispatchHotkeyAction(id === "closeTab" ? id : APP_HOTKEYS[id]);

export interface ShellActions {
  openCommand(): void;
  newInArea(): void;
  togglePinned(): void;
  togglePanel(): void;
  openSettings(): void;
  closeFloating(): void;
  floatingOpen: boolean;
}

export const AppHotkeys = ({ actions }: { actions: ShellActions }): null => {
  useAppHotkey(APP_HOTKEYS.command, actions.openCommand);
  useAppHotkey(APP_HOTKEYS.new, actions.newInArea);
  useAppHotkey(APP_HOTKEYS.toggleSidebar, actions.togglePinned, {
    guardRichText: true,
  });
  useAppHotkey(APP_HOTKEYS.togglePanel, actions.togglePanel, {
    guardRichText: true,
  });
  useAppHotkey(APP_HOTKEYS.settings, actions.openSettings);
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
