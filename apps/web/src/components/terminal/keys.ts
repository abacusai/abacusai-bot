import { matchesKeyboardEvent } from "@tanstack/react-hotkeys";

import {
  terminalAction,
  type TerminalAction as SharedTerminalAction,
} from "@abacus-ai/contract/terminal/keys";
export type TerminalAction =
  | SharedTerminalAction
  | "newTerminalTab"
  | "command"
  | "settings"
  | "toggleSidebar";
const terminalActions = {
  "command-menu": "command",
  "open-settings": "settings",
  "toggle-sidebar": "toggleSidebar",
  "close-tab": "closeTab",
  "next-tab": "nextTab",
  "previous-tab": "previousTab",
  "toggle-side-panel": "togglePanel",
  "new-in-area": "new",
  "new-terminal-tab": "newTerminalTab",
} as const;
export const terminalKeyHandler =
  (
    platform: "mac" | "windows" | "linux",
    dispatch: (id: TerminalAction) => void,
    terminal: {
      hasSelection(): boolean;
      getSelection(): string;
      paste(text: string): void;
      scrollPages(n: number): void;
      scrollToBottom(): void;
    },
    bindings?: Record<string, string | null> | null
  ) =>
  (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return false;
    const key = event.key.toLowerCase();
    const mac = platform === "mac";
    const match = bindings
      ? Object.entries(terminalActions).find(([id]) => {
          const binding = bindings[id];
          return (
            binding != null &&
            matchesKeyboardEvent(event, binding as never, platform)
          );
        })
      : undefined;
    const action = bindings ? match?.[1] : terminalAction(event, platform);
    if (action) {
      dispatch(action);
      return true;
    }
    if (
      event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (key === "pageup" || key === "pagedown")
    ) {
      terminal.scrollPages(key === "pageup" ? -1 : 1);
      return true;
    }
    const clipboard = mac
      ? event.metaKey && !event.ctrlKey && !event.shiftKey
      : event.ctrlKey && !event.metaKey && event.shiftKey;
    if (clipboard && !event.altKey && key === "c" && terminal.hasSelection()) {
      void navigator.clipboard.writeText(terminal.getSelection());
      return true;
    }
    if (clipboard && !event.altKey && key === "v") {
      void navigator.clipboard
        .readText()
        .then((text) => terminal.paste(text))
        .catch(() => {});
      return true;
    }
    if (
      ![
        "Shift",
        "Control",
        "Alt",
        "Meta",
        "CapsLock",
        "NumLock",
        "ScrollLock",
      ].includes(event.key)
    )
      terminal.scrollToBottom();
    return false;
  };
