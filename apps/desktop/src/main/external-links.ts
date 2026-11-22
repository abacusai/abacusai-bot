import { fileURLToPath } from "url";

/**
 * Schemes the app will hand to `shell.openExternal`. The OS picks the handler
 * from the scheme, so the reachable set is every protocol handler on the
 * machine (`file:` opens local content; Windows registers app schemes that
 * amount to "run this"), and the URLs come partly from agent-written HTML in
 * the preview pane. So the scheme is checked against a list, never trusted.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/**
 * Whether `url` may be handed to `shell.openExternal`. Parsing decides, never a
 * prefix match: an unparseable string is rejected rather than passed to
 * something with looser rules than ours.
 */
export const isSafeExternalUrl = (url: unknown): url is string => {
  if (typeof url !== "string" || url.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return ALLOWED_SCHEMES.has(parsed.protocol);
};

/**
 * The local path a `file:` URL names, or null when `url` is not one. Its
 * query and #fragment are dropped: the path is what gets checked and opened.
 * A URL naming another host is null too, since on Windows it becomes a
 * network share, and touching one can hand the account's hash to that host.
 */
export const localPathOfFileUrl = (url: unknown): string | null => {
  if (typeof url !== "string" || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return null;
  if (parsed.hostname !== "" && parsed.hostname !== "localhost") return null;
  parsed.hostname = "";
  parsed.search = "";
  parsed.hash = "";
  try {
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
};

/** The schemes `isSafeExternalUrl` accepts, for messages and tests. */
export const allowedExternalSchemes = (): string[] => [...ALLOWED_SCHEMES];

/** The bot's own upgrade page on the app host (abacus-upgrade.ts). */
const BOT_UPGRADE_PATH = "/bot/link/upgrade";

/**
 * The URL to hand the OS for `url`: the bot's upgrade page on `appHost` gets
 * `back=desktop`, so once paid the page opens the app again by its
 * abacusaibot:// link instead of the web app. Every way out of the app (a
 * button, a link in a chat reply, a routine's notice) passes here, so each
 * comes back. Anything else is returned unchanged.
 */
export const withUpgradeReturn = (url: string, appHost: string): string => {
  if (!URL.canParse(url) || !URL.canParse(appHost)) return url;
  const parsed = new URL(url);
  if (
    parsed.origin !== new URL(appHost).origin ||
    !parsed.pathname.endsWith(BOT_UPGRADE_PATH)
  )
    return url;
  parsed.searchParams.set("back", "desktop");
  return parsed.toString();
};
