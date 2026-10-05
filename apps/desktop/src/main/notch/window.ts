import { BaseWindow, WebContentsView } from "electron";

import type { Placement } from "./geometry";
import { rememberNotchWindow } from "./registry";
export const fitView = (win: BaseWindow, view: WebContentsView): void => {
  if (win.isDestroyed() || view.webContents.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  view.setBounds({ x: 0, y: 0, width, height });
};
export const createNotchView = (preload: string): WebContentsView => {
  const view = new WebContentsView({
    webPreferences: {
      preload,
      additionalArguments: ["--abacus-window=notch"],
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      webviewTag: false,
    },
  });
  try {
    view.setBackgroundColor("#00000000");
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event) => event.preventDefault());
    view.webContents.on("will-attach-webview", (event) =>
      event.preventDefault()
    );
    return view;
  } catch (error) {
    if (!view.webContents.isDestroyed()) view.webContents.close();
    throw error;
  }
};
export const createNotchWindow = (
  platform: string,
  placement: Placement,
  preload: string
) => {
  const win = new BaseWindow({
    type: platform === "darwin" ? "panel" : "toolbar",
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    acceptFirstMouse: true,
    ...(platform === "win32"
      ? { thickFrame: false, backgroundMaterial: "none" as const }
      : {}),
    ...placement.bounds,
  });
  rememberNotchWindow(win);
  let view: WebContentsView | null = null;
  try {
    win.excludedFromShownWindowsMenu = true;
    win.setAlwaysOnTop(
      true,
      platform === "darwin" ? "screen-saver" : "pop-up-menu"
    );
    if (platform === "darwin")
      win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    win.setBounds(placement.bounds);
    win.setIgnoreMouseEvents(true, { forward: true });
    view = createNotchView(preload);
    win.contentView.addChildView(view);
    fitView(win, view);
    const fitChildren = () => {
      for (const child of win.contentView.children)
        if (child instanceof WebContentsView) fitView(win, child);
    };
    win.on("resize", fitChildren);
    // The native content view can finish laying out after the window's resize
    // event on Linux. Fit the current children again at that boundary.
    win.contentView.on("bounds-changed", () => {
      const { width, height } = win.contentView.getBounds();
      for (const child of win.contentView.children)
        if (
          child instanceof WebContentsView &&
          !child.webContents.isDestroyed()
        )
          child.setBounds({ x: 0, y: 0, width, height });
    });
    return { win, view };
  } catch (error) {
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
};
