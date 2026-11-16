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

/**
 * The `_meta` key for sites where the run itself signed in during this chat
 * (it typed into the sign-in form, with details the user gave): told as
 * that, never as the user's own sign-in that was already there.
 */
export const SIGNED_IN_BY_RUN_META = "abacus/signedInByRunSites";

/** Added to a result on a site where the run itself signed in during this chat. */
export const signedInByRunNote = (site: string): string =>
  `The browser signed in to ${site} in this chat with the sign-in details the user gave (Connected sites): this page shows that account. When you report it, say the run signed in with those details; do not call it a sign-in that was already there.`;

/** The `_meta` for a result on a site where the run itself signed in. */
export const signedInByRunMeta = (
  sites: readonly string[]
): Record<string, string[]> => ({ [SIGNED_IN_BY_RUN_META]: [...sites] });

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
export function signedInSitesOf(
  meta: unknown,
  key: string = SIGNED_IN_META
): string[] {
  if (meta == null || typeof meta !== "object") return [];
  const sites = (meta as Record<string, unknown>)[key];
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

/**
 * For the chat's model, ahead of the run's report; "" when the run used no
 * sign-in. `byRun`: sites where the run itself signed in, with details the
 * user gave, told apart from the user's own sign-ins that were there.
 */
export function signedInLine(
  sites: readonly string[],
  byRun: readonly string[] = []
): string {
  const own = sites.filter((site) => !byRun.includes(site));
  const lines: string[] = [];
  if (own.length > 0) {
    const names = listed(own);
    lines.push(
      `(This run used the user's own sign-in on ${names} (Connected sites), so what it read there is their account, not a public page. Tell the user in your reply that their ${names} sign-in was used.)`
    );
  }
  if (byRun.length > 0) {
    const names = listed(byRun);
    lines.push(
      `(This run signed in to ${names} itself, with the sign-in details the user gave in this chat, so what it read there is that account. Tell the user it signed in with those details; do not call it a sign-in that was already there.)`
    );
  }
  return lines.join("\n");
}
