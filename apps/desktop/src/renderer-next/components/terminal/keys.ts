import { terminalAction, type TerminalAction } from "#shared/terminal/keys";
export type { TerminalAction } from "#shared/terminal/keys";
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
    }
  ) =>
  (event: KeyboardEvent): boolean => {
    if (event.type !== "keydown") return false;
    const key = event.key.toLowerCase();
    const mac = platform === "mac";
    const action = terminalAction(event, platform);
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
