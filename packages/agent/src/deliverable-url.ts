/**
 * Whether a local URL handed over as a deliverable answers. A URL on this
 * computer is an app the agent itself is meant to be running, so
 * `present_deliverable` asks it before presenting it: a link to a server that
 * is not running reads to the user as a finished app that is broken. Only
 * loopback is ever asked; a remote URL is not this tool's to probe. Shared by
 * the desktop's MCP tool and this package's own copy of it; node's fetch only.
 */

/** How long a local URL gets to answer before it counts as not answering. */
const LOCAL_URL_TIMEOUT_MS = 10_000;

export type LocalUrlCheck =
  | { ok: true; status: number }
  | { ok: false; reason: string };

/** A URL on this computer. */
export const isLoopbackUrl = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return (
      (protocol === "http:" || protocol === "https:") &&
      ["127.0.0.1", "localhost", "[::1]"].includes(hostname)
    );
  } catch {
    return false;
  }
};

/** Why a request never got an answer, in the model's terms. */
const unreachable = (error: unknown, timeoutMs: number): string => {
  if ((error as Error)?.name === "TimeoutError")
    return `it did not answer within ${timeoutMs / 1000}s`;
  // Node's fetch puts the socket's error code on `cause`.
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  if (code === "ECONNREFUSED")
    return "nothing is listening there (connection refused): the server is not running";
  return `it could not be reached (${code ?? (error as Error)?.message ?? "unknown error"})`;
};

/**
 * Asks a loopback `url` once, following redirects. It must answer below 400:
 * a 404 from the agent's own app is a wrong path or a broken build. A URL
 * that is not loopback is refused unasked.
 */
export async function checkLocalUrl(
  url: string,
  timeoutMs = LOCAL_URL_TIMEOUT_MS
): Promise<LocalUrlCheck> {
  if (!isLoopbackUrl(url))
    return { ok: false, reason: "only a URL on this computer is checked" };
  let status: number;
  try {
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    return { ok: false, reason: unreachable(error, timeoutMs) };
  }
  return status < 400
    ? { ok: true, status }
    : { ok: false, reason: `it answered HTTP ${status}` };
}
