import type { BaseWindow, WebContentsView } from "electron";
export const disposeView = (
  win: BaseWindow,
  view: WebContentsView,
  unregister: (id: number) => void
): void => {
  if (view.webContents.isDestroyed()) return;
  unregister(view.webContents.id);
  if (!win.isDestroyed()) win.contentView.removeChildView(view);
  view.webContents.close();
};
export const disposeNotchWindow = (
  entry: {
    disposed: boolean;
    win: BaseWindow;
    active: WebContentsView;
    standby: WebContentsView | null;
  },
  unregister: (id: number) => void
): void => {
  if (entry.disposed) return;
  entry.disposed = true;
  if (entry.standby) disposeView(entry.win, entry.standby, unregister);
  disposeView(entry.win, entry.active, unregister);
  if (!entry.win.isDestroyed()) entry.win.destroy();
};
