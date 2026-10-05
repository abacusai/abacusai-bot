/**
 * The `#` reservation (spec 00 C.3): ids the v1 mapper derives or
 * deduplicates use `#` (`id#2`, `bracket#0`, `segment#result`), so no id that
 * enters a thread from anywhere else may contain it. Native ids (client
 * message ids, the agent's AG-UI ids, provider tool call ids) pass through
 * `toNativeId` at ingress: an id without `#` or `%` is unchanged (every id
 * the agent and the kit produce today), and anything else is percent-encoded
 * into a namespace disjoint from the mapper's. `fromNativeId` restores it on
 * egress (for example, a tool call id sent back to the agent).
 */

export const RESERVED_ID_DELIMITER = "#";

/** True when `id` can enter a thread unchanged. */
export const isPlainNativeId = (id: string): boolean =>
  !id.includes("#") && !id.includes("%");

export const toNativeId = (id: string): string =>
  isPlainNativeId(id) ? id : id.replaceAll("%", "%25").replaceAll("#", "%23");

export const fromNativeId = (id: string): string =>
  id.includes("%") ? id.replaceAll("%23", "#").replaceAll("%25", "%") : id;
