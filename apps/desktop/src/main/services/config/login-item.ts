/**
 * Open at login (spec 05 §31.5 c): `app.getLoginItemSettings` /
 * `setLoginItemSettings` on macOS and Windows; on Linux an XDG autostart
 * entry, when the packaged app can name its own executable. Otherwise both
 * calls are refused with a typed error the RPC layer maps to
 * `PRECONDITION_FAILED { reason: "unsupported-platform" }`. Electron is
 * passed in so the procedures and tests load without it.
 */
import fs from "node:fs";
import path from "node:path";

export class UnsupportedPlatformError extends Error {
  readonly platform: string;

  constructor(platform: string, what: string) {
    super(`${what} is not supported on ${platform}`);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
  }
}

export interface LoginItemState {
  openAtLogin: boolean;
}

export interface LoginItemApp {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export interface LoginItem {
  get(): LoginItemState;
  set(openAtLogin: boolean): LoginItemState;
}

const SUPPORTED = new Set<string>(["darwin", "win32"]);

/** Linux's open-at-login: one entry in the user's autostart directory. */
export interface LinuxAutostart {
  read(): boolean;
  write(openAtLogin: boolean): void;
  /** Points an enabled entry at the current executable; an update can rename an AppImage. */
  refresh(): void;
}

/** A desktop-entry string value, quoted for `Exec` (XDG Desktop Entry spec). */
const execArgument = (value: string): string =>
  `"${value
    .replace(/[\\"`$]/g, (c) => `\\${c}`)
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "%%")}"`;

export const xdgAutostart = (options: {
  /** `$XDG_CONFIG_HOME`, else `~/.config`. */
  configHome: string;
  /** The app's own executable (the AppImage, or the installed binary). */
  executable: string;
  name: string;
}): LinuxAutostart => {
  const file = path.join(
    options.configHome,
    "autostart",
    "abacusai-bot.desktop"
  );
  const exec = `Exec=${execArgument(options.executable)}`;
  const readEntry = (): string | null => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  // How a desktop's own startup settings turn an entry off.
  const enabled = (entry: string): boolean =>
    !/^(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/m.test(
      entry
    );
  const writeEntry = (): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${options.name}`,
        exec,
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n")
    );
  };
  return {
    read() {
      const entry = readEntry();
      return entry != null && enabled(entry);
    },
    refresh() {
      const entry = readEntry();
      if (entry == null || !enabled(entry)) return;
      const current = /^Exec=.*$/m.exec(entry)?.[0];
      if (current === exec) return;
      if (current == null) writeEntry();
      else
        fs.writeFileSync(
          file,
          entry.replace(current, () => exec)
        );
    },
    write(openAtLogin) {
      if (!openAtLogin) {
        fs.rmSync(file, { force: true });
        return;
      }
      writeEntry();
    },
  };
};

export const createLoginItem = (
  app: LoginItemApp,
  platform: string = process.platform,
  linuxAutostart: LinuxAutostart | null = null
): LoginItem => {
  const linux = platform === "linux" ? linuxAutostart : null;
  const guard = (): void => {
    if (!SUPPORTED.has(platform) && linux == null)
      throw new UnsupportedPlatformError(platform, "Open at login");
  };
  return {
    get() {
      guard();
      if (linux != null) return { openAtLogin: linux.read() };
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    },
    set(openAtLogin) {
      guard();
      if (linux != null) {
        linux.write(openAtLogin);
        return { openAtLogin: linux.read() };
      }
      app.setLoginItemSettings({ openAtLogin });
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    },
  };
};
