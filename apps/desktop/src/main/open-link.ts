/**
 * `abacusaibot://` links (contract open-link.ts): registered with the OS, and
 * held here until the renderer is signed in and takes them. macOS hands a
 * link over as `open-url`; Windows and Linux start the app with it in argv,
 * or pass it to the running one through `second-instance`.
 */
import {
  OPEN_LINK_SCHEME,
  openLinkInArgv,
  parseOpenLink,
  type OpenLink,
} from "@abacus-ai/contract/open-link";

interface OpenLinkDeps {
  /** Brings the main window up, when there is one. */
  reveal(): void;
  /** Tells a listening renderer a link waits. */
  announce(): void;
  funnel(src: string): void;
}

/** The latest link, until the renderer takes it: a newer link replaces an older one. */
export class OpenLinkInbox {
  private pending: OpenLink | null = null;

  constructor(private readonly deps: OpenLinkDeps) {}

  receive(raw: unknown): boolean {
    const link = parseOpenLink(raw);
    if (link == null) return false;
    this.pending = link;
    this.deps.funnel(link.src);
    this.deps.reveal();
    this.deps.announce();
    return true;
  }

  take(): OpenLink | null {
    const link = this.pending;
    this.pending = null;
    return link;
  }
}

// `app.relaunch()` repeats argv and keeps the environment, so a relaunch
// marks the link it already opened instead of opening it again.
const ARGV_LINK_ENV = "ABACUSAI_BOT_OPENED_LINK";

/** The link this process was started with, once per launch chain. */
export const launchLink = (
  argv: readonly string[],
  env: NodeJS.ProcessEnv
): string | null => {
  const raw = openLinkInArgv(argv);
  if (raw == null || env[ARGV_LINK_ENV] === raw) return null;
  env[ARGV_LINK_ENV] = raw;
  return raw;
};

/**
 * Makes this install the scheme's handler. Packaged builds only: a dev run
 * would take the scheme from an installed app. macOS reads it from the
 * bundle (electron-builder `protocols`), and the Linux packages from the
 * .desktop file's MimeType; the call covers Windows and an AppImage.
 */
export const registerOpenLinkScheme = (app: {
  isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
}): void => {
  if (!app.isPackaged || process.platform === "darwin") return;
  try {
    app.setAsDefaultProtocolClient(OPEN_LINK_SCHEME);
  } catch (error) {
    console.warn(`[open-link] scheme not registered: ${String(error)}`);
  }
};
