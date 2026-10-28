/**
 * The tray icon shown on Windows and Linux while the main window is hidden in
 * the background, so a closed-but-running app can always be reopened or quit.
 * Created on the first hide and kept until quit; relabelled on a language
 * change. macOS never needs it: the Dock icon does this job.
 */
import { Menu, Notification, Tray, nativeImage } from "electron";

interface BackgroundTrayOptions {
  /** The app icon's file (.ico on Windows, a PNG elsewhere). */
  iconPath: string;
  tooltip: string;
  labels: () => { open: string; quit: string; stillRunning: string };
  open(): void;
  quit(): void;
}

let tray: Tray | null = null;
let told = false;
let current: BackgroundTrayOptions | null = null;

function trayMenu(options: BackgroundTrayOptions): Menu {
  const labels = options.labels();
  return Menu.buildFromTemplate([
    { label: labels.open, click: () => options.open() },
    { type: "separator" },
    { label: labels.quit, click: () => options.quit() },
  ]);
}

/**
 * Show the tray icon (once) and, the first time this run, say the app is still
 * running there. Never throws: without a tray the second-instance handler
 * still brings the window back when the app is launched again.
 */
export function showBackgroundTray(options: BackgroundTrayOptions): void {
  current = options;
  try {
    if (tray === null || tray.isDestroyed()) {
      const image = nativeImage.createFromPath(options.iconPath);
      // An .ico already carries the tray sizes; a large PNG needs scaling.
      const icon =
        process.platform === "win32"
          ? image
          : image.resize({ width: 32, height: 32 });
      tray = new Tray(icon);
      tray.setToolTip(options.tooltip);
      // Windows opens on a click; Linux trays only ever show the menu.
      tray.on("click", () => current?.open());
      tray.setContextMenu(trayMenu(options));
    }
  } catch (error) {
    console.warn("[tray] unavailable", error);
    return;
  }
  if (told) return;
  told = true;
  const { stillRunning } = options.labels();
  if (process.platform === "win32") {
    tray.displayBalloon({
      title: options.tooltip,
      content: stillRunning,
      iconType: "info",
      noSound: true,
    });
  } else if (Notification.isSupported()) {
    new Notification({
      title: options.tooltip,
      body: stillRunning,
      silent: true,
    }).show();
  }
}

/** Rebuild the menu in the current language; a no-op without a tray. */
export function relabelBackgroundTray(): void {
  if (tray === null || tray.isDestroyed() || current === null) return;
  tray.setContextMenu(trayMenu(current));
}

/** Remove the icon before exit so Windows leaves no ghost in the tray. */
export function disposeBackgroundTray(): void {
  if (tray !== null && !tray.isDestroyed()) tray.destroy();
  tray = null;
}
