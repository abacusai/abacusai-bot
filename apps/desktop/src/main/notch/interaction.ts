import type { BaseWindow } from "electron";

// Hover changes mouse routing only. It must never revoke a typing session.
const typing = new WeakSet<BaseWindow>();
export const setInteractive = (win: BaseWindow, interactive: boolean): void => {
  win.setIgnoreMouseEvents(!interactive && !typing.has(win), { forward: true });
};
export const setFocused = (win: BaseWindow, focused: boolean): void => {
  if (focused) {
    typing.add(win);
    win.setIgnoreMouseEvents(false, { forward: true });
    win.setFocusable(true);
    win.focus();
  } else {
    typing.delete(win);
    // Relinquishing key status lets the non-activating macOS panel return focus
    // to the previous app. Pointer routing remains the renderer's decision.
    win.blur();
    win.setFocusable(false);
  }
};
