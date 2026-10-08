/**
 * What a "site" is, everywhere the browser, the vault and a checkout compare
 * one: the registrable domain by the public suffix list, private suffixes
 * included, the same rule the server uses. Two buckets under
 * `s3.us-west-2.amazonaws.com`, or two `github.io` or `myshopify.com` stores,
 * are two sites.
 *
 * The list here is tldts's snapshot and the server has its own, so they can
 * differ for a suffix one of them has not picked up yet; the server's check
 * decides what a fill or approval binds to. A name under a suffix not on the
 * list (`shop.example`) gets the one-label default here, where the server
 * refuses it: no approval or fill can exist for it, so that fails closed.
 */
import { getDomain } from "tldts";

/**
 * A host's registrable domain (`www.bbc.co.uk` → `bbc.co.uk`, `a.github.io`
 * stays itself); null for an IP, `localhost` or a bare public suffix.
 */
export function registrableDomain(host: string): string | null {
  return getDomain(host.toLowerCase(), {
    allowPrivateDomains: true,
    validateHostname: true,
  });
}

/** Whether two hosts are one site; a host with no registrable domain is only itself. */
export function sameSite(a: string, b: string): boolean {
  const site = registrableDomain(a);
  return site != null
    ? site === registrableDomain(b)
    : a.toLowerCase() === b.toLowerCase();
}

/** Whether `host` is on `site`, a registrable domain as the server bound it. */
export function onSite(host: string, site: string): boolean {
  return site.length > 0 && registrableDomain(host) === site.toLowerCase();
}

/**
 * The registrable domain a `site` argument names, with what models wrap it
 * in dropped ("skyfare.com (SkyFare Air)", "https://www.skyfare.com/book");
 * null when none is left.
 */
export function siteArgument(text: string): string | null {
  const host = text
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#\s]/)[0]!
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return /^[a-z0-9.-]{1,253}$/.test(host) ? registrableDomain(host) : null;
}
