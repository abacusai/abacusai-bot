/**
 * Hosts the agent's browser never loads or acts on, as exact host names and
 * dot-led suffixes, with the three forms the browser tools need: a check of
 * a URL, CDP block patterns, and a guard that runs inside each page script
 * so a document that became one of them since the last check runs nothing.
 */

export interface HostFence {
  /** Host names fenced exactly, e.g. `abacus.ai`. */
  exact: readonly string[];
  /** Suffixes (with their leading dot) whose every host is fenced, e.g. `.abacus.ai`. */
  suffixes: readonly string[];
}

const normalize = (host: string): string =>
  host.toLowerCase().replace(/\.$/, "");

/** Whether `host` is behind the fence. */
export const isFencedHost = (host: string, fence: HostFence): boolean => {
  const name = normalize(host);
  return (
    name.length > 0 &&
    (fence.exact.includes(name) ||
      fence.suffixes.some((suffix) => name.endsWith(suffix)))
  );
};

/** Whether `url` (or a bare `host/path`) is on a fenced host. */
export const isFencedUrl = (url: string | null, fence: HostFence): boolean => {
  if (url == null || url.length === 0) return false;
  for (const candidate of [url, `https://${url}`]) {
    try {
      return isFencedHost(new URL(candidate).hostname, fence);
    } catch {
      // Not a URL as written; try it as a bare host.
    }
  }
  return false;
};

/** The fence as CDP `Network.setBlockedURLs` patterns. */
export const fenceBlockPatterns = (fence: HostFence): string[] => [
  ...fence.exact.map((host) => `*://${host}/*`),
  ...fence.suffixes.map((suffix) => `*://*${suffix}/*`),
];

/** What a page script throws when its document is behind the fence. */
export const FENCE_ERROR = "abacusai-host-fence";

/**
 * An expression that throws `FENCE_ERROR` when the document it runs in is
 * on a fenced host. Put ahead of a page script, it is checked by the same
 * evaluation, so nothing runs on a document a navigation brought there.
 */
export const fenceGuardExpression = (fence: HostFence): string => `(function() {
  const host = String(location.hostname).toLowerCase().replace(/\\.$/, '');
  const exact = ${JSON.stringify(fence.exact)};
  const suffixes = ${JSON.stringify(fence.suffixes)};
  if (host && (exact.includes(host) || suffixes.some((suffix) => host.endsWith(suffix))))
    throw new Error(${JSON.stringify(FENCE_ERROR)});
})()`;
