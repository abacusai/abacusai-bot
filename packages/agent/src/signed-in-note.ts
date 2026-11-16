/**
 * The user's own sign-in, from the browser to the user. A leaf module: the
 * desktop's browser server (`@abacus-ai/agent/signed-in-note`) writes the
 * note on a page of a connected site the browser is signed in to, and names
 * the site in the result's `_meta`; a browser run collects the sites from
 * that field (never from text, which a page can write), and the chat's
 * model is handed a line to tell the user. A run's own report saying so was not
 * enough: the chat's reply summed it up and dropped it.
 */

/** Added to a browser call's result on a page that shows the user's own account. */
export const signedInNote = (site: string): string =>
  `The browser is signed in to ${site} with the user's own account (Connected sites): this page shows their account, not what anyone would see. Say that the user's sign-in was used when you report it.`;

/**
 * The MCP `_meta` key on a browser result that names the sites whose sign-in
 * the page used: set by the app's browser server on every such call, read
 * by a run. Never read from text: a page can write any sentence.
 */
export const SIGNED_IN_META = "abacus/signedInSites";

/** The app's own browser server: the only one whose `_meta` is taken for a sign-in. */
export const SIGNED_IN_SERVER = "browser";

/** The `_meta` for a result on a page that shows the user's own account on `sites`. */
export const signedInMeta = (
  sites: readonly string[]
): Record<string, string[]> => ({
  [SIGNED_IN_META]: [...sites],
});

const SITE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

/** The sites a result's `_meta` (or a tool result's details) names, once each. */
export function signedInSitesOf(meta: unknown): string[] {
  if (meta == null || typeof meta !== "object") return [];
  const sites = (meta as Record<string, unknown>)[SIGNED_IN_META];
  if (!Array.isArray(sites)) return [];
  return [
    ...new Set(
      sites.filter(
        (site): site is string => typeof site === "string" && SITE.test(site)
      )
    ),
  ];
}

const listed = (sites: readonly string[]): string =>
  sites.length <= 1
    ? (sites[0] ?? "")
    : `${sites.slice(0, -1).join(", ")} and ${sites.at(-1)}`;

/** For the chat's model, ahead of the run's report; "" when the run used none. */
export function signedInLine(sites: readonly string[]): string {
  if (sites.length === 0) return "";
  const names = listed(sites);
  return `(This run used the user's own sign-in on ${names} (Connected sites), so what it read there is their account, not a public page. Tell the user in your reply that their ${names} sign-in was used.)`;
}
