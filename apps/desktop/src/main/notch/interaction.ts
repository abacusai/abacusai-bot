import type { BaseWindow } from "electron";
export const setInteractive = (win: BaseWindow, interactive: boolean): void => {
  win.setIgnoreMouseEvents(!interactive, { forward: true });
  if (!interactive) setFocused(win, false);
};
export const setFocused = (win: BaseWindow, focused: boolean): void => {
  win.setFocusable(focused);
  win.setIgnoreMouseEvents(!focused, { forward: true });
  if (focused) win.focus();
  else win.blur();
};
