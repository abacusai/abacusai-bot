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

/** The schemes `isSafeExternalUrl` accepts, for messages and tests. */
export const allowedExternalSchemes = (): string[] => [...ALLOWED_SCHEMES];
