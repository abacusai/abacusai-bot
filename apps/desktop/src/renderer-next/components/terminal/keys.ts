export type TerminalAction =
  | "closeTab"
  | "nextTab"
  | "previousTab"
  | "togglePanel"
  | "new";
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
    let action: TerminalAction | undefined;
    if (event.ctrlKey && !event.metaKey && !event.altKey && key === "tab")
      action = event.shiftKey ? "previousTab" : "nextTab";
    if (
      (mac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey) &&
      event.altKey &&
      !event.shiftKey &&
      key === "b"
    )
      action = "togglePanel";
    if (
      mac &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      key === "w"
    )
      action = "closeTab";
    if (
      !mac &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.shiftKey &&
      key === "w"
    )
      action = "closeTab";
    if (
      mac &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      key === "n"
    )
      action = "new";
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
