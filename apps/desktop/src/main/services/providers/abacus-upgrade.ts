import { credentialFor } from "../config/settings";
import { abacusApiCall } from "./abacus-connector-service";

/**
 * The account's own upgrade page: a one-time link the platform binds to the
 * signed-in user, live for 30 minutes (asking again while it is live returns
 * the same one). Null when the account has no upgrade offer, such as a paid
 * plan, when signed out, or when the call fails.
 */

/** Well inside the link's life, so a cached link is never a dead one. */
const UPGRADE_URL_TTL_MS = 60_000;

let cached: { key: string; url: string | null; at: number } | null = null;

export const fetchUpgradeUrl = async (): Promise<string | null> => {
  const key = credentialFor("ABACUS_API_KEY");
  if (key.length === 0) return null;
  if (
    cached != null &&
    cached.key === key &&
    Date.now() - cached.at < UPGRADE_URL_TTL_MS
  )
    return cached.url;
  const { ok, result } = await abacusApiCall(
    "_createAbacusbotUpgradeLink",
    "GET"
  );
  if (!ok) return null;
  const url =
    result != null && typeof result === "object"
      ? (result as Record<string, unknown>).url
      : null;
  const link =
    typeof url === "string" && url.startsWith("https://") ? url : null;
  cached = { key, url: link, at: Date.now() };
  return link;
};
