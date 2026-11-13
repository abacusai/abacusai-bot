/**
 * The tray icon that keeps a closed app reachable on Windows and Linux: a
 * click opens the window, its menu opens it or quits. Up only while "Keep
 * running in the background" is on and the desktop can show it.
 */
import { execFile } from "node:child_process";

import { Menu, type NativeImage, Tray } from "electron";

/** Electron's Linux tray is a StatusNotifierItem; without a watcher (plain GNOME) nothing shows. */
const linuxTrayHost = (): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      "dbus-send",
      [
        "--session",
        "--print-reply",
        "--dest=org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus.NameHasOwner",
        "string:org.kde.StatusNotifierWatcher",
      ],
      { timeout: 3_000 },
      (error, stdout) => resolve(error == null && /boolean true/.test(stdout))
    );
  });

export interface BackgroundTrayOptions {
  platform: string;
  icon(): NativeImage;
  tooltip: string;
  labels(): { open: string; quit: string };
  open(): void;
  quit(): void;
}

export class BackgroundTray {
  private tray: Tray | null = null;
  private wanted = false;
  private generation = 0;
  private readonly host: Promise<boolean>;
  private createFailed = false;
  private disposed = false;
  private syncing: Promise<void> = Promise.resolve();

  constructor(private readonly options: BackgroundTrayOptions) {
    // Asked once, at launch, so the answer is in before the window asks.
    this.host =
      options.platform === "linux" ? linuxTrayHost() : Promise.resolve(true);
  }

  /** The icon is up, so a closed window can come back. */
  get shown(): boolean {
    return this.tray != null && !this.tray.isDestroyed();
  }

  /** This desktop can show the icon: the desktop's answer, then the latest sync's. */
  async available(): Promise<boolean> {
    const host = await this.host;
    await this.settled();
    return host && !this.createFailed;
  }

  /** Puts the icon up or takes it down; a desktop that cannot show one leaves it down. */
  sync(want: boolean): Promise<void> {
    if (this.disposed || want === this.wanted) return this.syncing;
    this.wanted = want;
    this.syncing = this.apply(want, ++this.generation);
    return this.syncing;
  }

  /** Whether the icon is up once the latest sync has finished. */
  async settled(): Promise<boolean> {
    let current: Promise<void>;
    do {
      current = this.syncing;
      await current;
    } while (current !== this.syncing);
    return this.shown;
  }

  /** On quit: an icon left behind lingers in the Windows tray until hovered. */
  dispose(): void {
    this.disposed = true;
    this.wanted = false;
    this.generation++;
    this.tray?.destroy();
    this.tray = null;
  }

  private async apply(want: boolean, generation: number): Promise<void> {
    if (!want) {
      this.tray?.destroy();
      this.tray = null;
      return;
    }
    if (!(await this.host)) {
      console.warn("[tray] no tray on this desktop; closing quits");
      return;
    }
    if (generation !== this.generation) return;
    try {
      const tray = new Tray(this.options.icon());
      tray.setToolTip(this.options.tooltip);
      tray.setContextMenu(this.menu());
      tray.on("click", () => this.options.open());
      this.tray = tray;
    } catch (error) {
      console.warn(
        `[tray] not created: ${error instanceof Error ? error.message : String(error)}`
      );
      this.tray = null;
      this.createFailed = true;
    }
  }

  /** After a language change. */
  relabel(): void {
    if (this.shown) this.tray!.setContextMenu(this.menu());
  }

  private menu(): Menu {
    const labels = this.options.labels();
    return Menu.buildFromTemplate([
      { label: labels.open, click: () => this.options.open() },
      { type: "separator" },
      { label: labels.quit, click: () => this.options.quit() },
    ]);
  }
}
