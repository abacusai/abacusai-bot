/**
 * The user's own sign-in, from the browser to the user. A leaf module: the
 * desktop's browser server (`@abacus-ai/agent/signed-in-note`) writes the
 * note on a page of a connected site the browser is signed in to; a browser
 * run reads the sites back from its tool results, and the chat's model is
 * handed a line to tell the user. A run's own report saying so was not
 * enough: the chat's reply summed it up and dropped it.
 */

/** Added to a browser call's result on a page that shows the user's own account. */
export const signedInNote = (site: string): string =>
  `The browser is signed in to ${site} with the user's own account (Connected sites): this page shows their account, not what anyone would see. Say that the user's sign-in was used when you report it.`;

const NOTE =
  /The browser is signed in to (\S+) with the user's own account \(Connected sites\)/g;

/** The sites whose sign-in the browser said it used, once each, in order. */
export function signedInSites(text: string): string[] {
  return [...new Set([...text.matchAll(NOTE)].map((match) => match[1]!))];
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
