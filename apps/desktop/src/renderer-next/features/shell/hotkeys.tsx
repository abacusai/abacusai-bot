/**
 * The app's only keyboard handler for app shortcuts (spec 01 §7.9). Every
 * binding is exact (`Mod+Alt+B` never fires `Mod+B`); the platform comes once
 * from `HotkeysProvider` (`toHotkeyPlatform(system.info.platform)`).
 *
 * The provider defaults turn the library's own preventDefault/stopPropagation
 * off, because it cancels *before* the callback: `useAppHotkey` decides, so a
 * rich-text target keeps native Mod+B (bold) when `guardRichText` is set.
 */
import {
  formatForDisplay,
  HotkeysProvider,
  useHotkey,
} from "@tanstack/react-hotkeys";
import type { ReactNode } from "react";

import type { HotkeyPlatform } from "#next/lib/platform";

export const APP_HOTKEYS = {
  command: "Mod+K",
  new: "Mod+N",
  toggleSidebar: "Mod+B",
  togglePanel: "Mod+Alt+B",
  settings: "Mod+,",
  escape: "Escape",
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

/** A contenteditable target, or one inside `[data-hotkeys="text"]`. */
const isRichTextTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (element == null || typeof element.closest !== "function") return false;
  if (element.isContentEditable) return true;
  // jsdom has no isContentEditable; the attribute decides there.
  const editable = element.closest("[contenteditable]");
  if (editable != null && editable.getAttribute("contenteditable") !== "false")
    return true;
  return element.closest('[data-hotkeys="text"]') != null;
};

const useAppHotkey = (
  binding: string | null,
  handler: () => void,
  options: {
    guardRichText?: boolean;
    enabled?: boolean;
    actionId?: string;
  } = {}
): void => {
  useHotkey(
    (binding ?? "F24") as never,
    (event) => {
      if (options.guardRichText === true && isRichTextTarget(event.target))
        return;
      event.preventDefault();
      handler();
    },
    {
      // App shortcuts fire in inputs and textareas too (§7.9 table).
      ignoreInputs: false,
      enabled: binding != null && (options.enabled ?? true),
      meta: { actionId: options.actionId },
    }
  );
};

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
