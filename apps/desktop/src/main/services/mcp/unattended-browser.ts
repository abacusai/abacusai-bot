/**
 * The browser, for a run nobody is watching: it opens the one page the
 * routine declared, in a browser context of its own, and reads it. Nothing is
 * typed, clicked or run, no other address is opened, and a page that ends up
 * on another host is left before anything on it is read.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  isNonPublicAddress,
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
  if (canonical(held.watchUrl)?.startsWith("https://") !== true)
    return "A routine only opens an https page.";
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

/** The port a watch page is served on, or undefined when it is not a URL. */
export function watchPort(watchUrl: string | null): number | undefined {
  if (watchUrl == null) return undefined;
  try {
    const url = new URL(watchUrl);
    if (url.port !== "") return Number(url.port);
    return url.protocol === "http:" ? 80 : 443;
  } catch {
    return undefined;
  }
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
      normalizeHost(current.hostname) === normalizeHost(watched.hostname) &&
      current.port === watched.port
    );
  } catch {
    return false;
  }
}

/**
 * Whether the watch page's host answers only with public addresses, asked
 * right before the page is opened: a name that points inside (a cloud
 * metadata address, the local network) is never opened.
 */
export async function watchHostIsPublic(
  watchUrl: string,
  resolve: (host: string) => Promise<Array<{ address: string }>> = (host) =>
    lookup(host, { all: true })
): Promise<boolean> {
  let host: string;
  try {
    host = new URL(watchUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (isIP(host) !== 0) return !isNonPublicAddress(host);
  try {
    const addresses = await resolve(host);
    return (
      addresses.length > 0 &&
      addresses.every(({ address }) => !isNonPublicAddress(address))
    );
  } catch {
    return false;
  }
}
