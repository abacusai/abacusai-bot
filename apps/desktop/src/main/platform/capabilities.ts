export type HostPlatform = "electron" | "web-host";
export const WEB_HOST_DENIED = [
  "window",
  "notch",
  "devices",
  "localModels",
  "update.events",
  "update.check",
  "update.install",
  "browser.runtime",
  "browser.profiles",
  "browser.clearData",
  "mcp.oauthSignIn",
  "auth.abacus.start",
  "auth.abacus.cancel",
  "auth.abacus.openInBrowser",
  "auth.abacus.browserProfiles",
  "auth.abacus.shouldAutoSignIn",
  "auth.openRouter.start",
  "auth.openRouter.cancel",
  "system.loginItem",
  "system.restart",
  "system.openPath",
  "system.showItemInFolder",
  "system.openPrivacyPane",
  "skills.openFile",
] as const;
export const supportsProcedure = (
  platform: HostPlatform,
  procedure: string,
  input?: unknown
): boolean =>
  platform === "electron" ||
  (!WEB_HOST_DENIED.some(
    (path) => procedure === path || procedure.startsWith(path + ".")
  ) &&
    !(
      procedure === "mcp.import" &&
      (input as { source?: string } | undefined)?.source === "file"
    ));
