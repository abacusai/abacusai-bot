/**
 * Open at login (spec 05 §31.5 c): `app.getLoginItemSettings` /
 * `setLoginItemSettings`, which Electron supports on macOS and Windows only.
 * On Linux both calls are refused with a typed error the RPC layer maps to
 * `PRECONDITION_FAILED { reason: "unsupported-platform" }`. Electron is
 * passed in so the procedures and tests load without it.
 */

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

export const createLoginItem = (
  app: LoginItemApp,
  platform: string = process.platform
): LoginItem => {
  const guard = (): void => {
    if (!SUPPORTED.has(platform))
      throw new UnsupportedPlatformError(platform, "Open at login");
  };
  return {
    get() {
      guard();
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    },
    set(openAtLogin) {
      guard();
      app.setLoginItemSettings({ openAtLogin });
      return { openAtLogin: app.getLoginItemSettings().openAtLogin };
    },
  };
};
