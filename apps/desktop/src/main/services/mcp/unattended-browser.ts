/**
 * The browser, for a run nobody is watching: it opens the one page the
 * routine declared, in a browser context of its own, and reads it. Nothing is
 * typed, clicked or run, no other address is opened, and a page that ends up
 * on another host is left before anything on it is read.
 */
import {
  normalizeHost,
  UNATTENDED_BROWSER_TOOLS,
} from "@abacus-ai/agent/tool-policy";

/** What the browser server knows about an unattended session. */
export interface HeldBrowserSession {
  /** The one page the routine declared, or null when it declared none. */
  watchUrl: string | null;
  /** Whether this browser can give the run a context apart from the profile. */
  isolated: boolean;
}

/** A URL as compared: parsed and re-serialized, or null when it is not one. */
const canonical = (raw: string): string | null => {
  try {
    return new URL(raw).href;
  } catch {
    return null;
  }
};

/**
 * Why a held session may not make this call, or null when it may. Checked
 * before the call is queued or a page exists.
 */
export function heldBrowserRefusal(
  name: string,
  args: Record<string, unknown>,
  held: HeldBrowserSession
): string | null {
  if (!UNATTENDED_BROWSER_TOOLS.includes(name))
    return `${name} is not available in a routine that runs on its own: it only reads its page.`;
  if (!held.isolated || held.watchUrl == null)
    return "This routine has no browser here.";
  if (name !== "browser_navigate") return null;
  const action =
    typeof args.action === "string"
      ? args.action
      : typeof args.url === "string"
        ? "goto"
        : "";
  if (action === "reload") return null;
  if (action !== "goto")
    return "A routine opens its own page and nothing else.";
  const wanted = canonical(held.watchUrl);
  const asked = typeof args.url === "string" ? canonical(args.url) : null;
  return wanted != null && asked === wanted
    ? null
    : "A routine opens exactly the page it was set up to watch, and nothing else.";
}

/**
 * Whether a held session's page is still on its watch page's host: a
 * redirect or a script that took it anywhere else means nothing is read.
 */
export function onWatchHost(currentUrl: string, watchUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const watched = new URL(watchUrl);
    return (
      current.protocol === watched.protocol &&
      normalizeHost(current.hostname) === normalizeHost(watched.hostname)
    );
  } catch {
    return false;
  }
}
