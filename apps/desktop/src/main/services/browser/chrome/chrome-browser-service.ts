/**
 * "Use my Chrome": the agent's browser tools drive tabs in the user's own
 * Chrome (signed-in sessions and all) through the Playwright Extension,
 * instead of the app's built-in view. This service owns the relay the
 * extension connects to, opens the connect page that asks the user to allow
 * it, and hands the browser tools a target source over the tabs it gets.
 */
import { spawn } from "node:child_process";

import type { ChromeBrowserStatus } from "#shared/contracts";

import type { BrowserTargetSource } from "../browser-target";
import {
  findChrome,
  isExtensionInstalled,
  PLAYWRIGHT_EXTENSION_ID,
  PLAYWRIGHT_EXTENSION_INSTALL_URL,
  type ChromeInstall,
} from "./chrome-executable";
import { ChromeRelay } from "./chrome-relay";
import { ChromeTargetSource } from "./chrome-target-source";

/** The name the tab group in Chrome carries. */
export const CLIENT_NAME = "AbacusAI Bot";

export interface ChromeBrowserServiceOptions {
  onStatusChanged: () => void;
  /** The extension's own token, when the user pasted it: skips the allow page. */
  token: () => string | undefined;
  /** Test seams. */
  findChrome?: () => ChromeInstall | null;
  isExtensionInstalled?: (userDataDir: string) => boolean;
  openInBrowser?: (install: ChromeInstall, url: string) => void;
  connectTimeoutMs?: number;
}

const openInChrome = (install: ChromeInstall, url: string): void => {
  const args: string[] = [];
  if (process.platform === "linux") args.push("--no-sandbox");
  args.push(url);
  spawn(install.executable, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
};

export class ChromeBrowserService {
  private relay: ChromeRelay | null = null;
  private source: ChromeTargetSource | null = null;
  private connecting = false;
  private lastError: string | null = null;

  constructor(private readonly options: ChromeBrowserServiceOptions) {}

  status(): ChromeBrowserStatus {
    const install = (this.options.findChrome ?? findChrome)();
    return {
      browser: install?.name ?? null,
      extensionInstalled:
        install != null &&
        (this.options.isExtensionInstalled ?? isExtensionInstalled)(
          install.userDataDir
        ),
      installUrl: PLAYWRIGHT_EXTENSION_INSTALL_URL,
      connecting: this.connecting,
      connected: this.relay?.connected === true,
      tabs: this.relay?.attachedTabs().length ?? 0,
      error: this.lastError,
    };
  }

  /**
   * The tools' target source. Not connected yet, it is one whose first tab
   * request connects: the allow page opens in Chrome and the tab is made once
   * the user lets the app in, so "use my Chrome" needs no separate setup step.
   */
  targetSource(): BrowserTargetSource {
    return {
      presentsInApp: false,
      candidates: () => this.source?.candidates() ?? [],
      webContents: (id) => this.source?.webContents(id) ?? null,
      materialize: async (sessionId, url) => {
        if (this.relay?.connected !== true) {
          const status = await this.connect();
          if (!status.connected) {
            throw new Error(status.error ?? "Chrome is not connected");
          }
        }
        return this.source?.materialize(sessionId, url) ?? null;
      },
    };
  }

  /**
   * Open the extension's connect page in the user's Chrome and wait for the
   * user to allow it (or for the token to let it through). Resolves with the
   * status either way; a failure is in `error`.
   */
  async connect(): Promise<ChromeBrowserStatus> {
    if (this.relay?.connected) return this.status();
    if (this.connecting) return this.status();
    const install = (this.options.findChrome ?? findChrome)();
    this.lastError = null;
    if (install == null) {
      this.lastError =
        "Google Chrome or Microsoft Edge was not found on this computer.";
      return this.status();
    }
    if (
      !(this.options.isExtensionInstalled ?? isExtensionInstalled)(
        install.userDataDir
      )
    ) {
      this.lastError =
        "The Playwright Extension is not installed in the browser.";
      return this.status();
    }

    this.connecting = true;
    this.options.onStatusChanged();
    try {
      this.disconnect();
      const relay = new ChromeRelay();
      await relay.listen();
      this.relay = relay;
      this.source = new ChromeTargetSource(relay);
      relay.on("disconnected", () => {
        this.lastError = null;
        this.options.onStatusChanged();
      });
      relay.on("tabAttached", () => this.options.onStatusChanged());
      relay.on("tabDetached", () => this.options.onStatusChanged());
      (this.options.openInBrowser ?? openInChrome)(
        install,
        relay.connectUrl(
          PLAYWRIGHT_EXTENSION_ID,
          CLIENT_NAME,
          this.options.token()
        )
      );
      await relay.waitForConnection(this.options.connectTimeoutMs);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.disconnect();
    } finally {
      this.connecting = false;
      this.options.onStatusChanged();
    }
    return this.status();
  }

  disconnect(): void {
    const relay = this.relay;
    this.relay = null;
    this.source = null;
    relay?.close("disconnected by the app");
  }

  dispose(): void {
    this.disconnect();
  }
}
