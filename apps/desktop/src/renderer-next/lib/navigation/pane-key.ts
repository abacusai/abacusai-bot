/**
 * The content pane's identity (spec 01 §6.7). The keyed `<ViewTransition>`
 * around the pane re-keys only when this changes, so a pop-up opening over
 * its background, or a search-only change, keeps the background mounted with
 * its scroll and state.
 *
 * PANE_BOUNDARIES maps real route ids (groups and pathless layouts included;
 * index ids end with "/") to a shared key per background/pop-up family.
 * Checked against the generated FileRoutesById.
 */
import type { FileRoutesById } from "#next/routeTree.gen";

export const PANE_BOUNDARIES = {
  "/_shell/(sessions)/sessions/$sessionId": "session:$sessionId",
  "/_shell/(sessions)/sessions/$sessionId/diff": "session:$sessionId",
  "/_shell/(sessions)/sessions/$sessionId/review": "session:$sessionId",
  "/_shell/(routines)/routines/_list/": "routines-list",
  "/_shell/(routines)/routines/_list/new": "routines-list",
  "/_shell/(bots)/bots/$botId": "bot:$botId",
  "/_shell/(bots)/bots/$botId/check-in": "bot:$botId",
  // The connector sheet is search-driven on the same route.
  "/_shell/(library)/library/connectors": "library-connectors",
} as const satisfies Partial<Record<keyof FileRoutesById, string>>;

const substitute = (template: string, params: Record<string, string>): string =>
  template.replace(/\$(\w+)/g, (_, name: string) => params[name] ?? "");

/** Search never enters the key. */
export const paneKey = (
  leafRouteId: string,
  params: Record<string, string>
): string => {
  const boundary = (PANE_BOUNDARIES as Record<string, string>)[leafRouteId];
  if (boundary !== undefined) return substitute(boundary, params);
  const values = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return values === "" ? leafRouteId : `${leafRouteId}?${values}`;
};
