/**
 * Fetching one URL, safely, with no credential. The model picks the URL and can
 * be steered by what it just read, so every URL is treated as attacker-
 * influenced: http(s) only, no embedded credentials, redirects followed only
 * within the same origin, the link-local range refused at every hop, and
 * responses capped by bytes and characters with binary refused outright.
 * Loopback and private addresses are allowed for the first hop (checking a dev
 * server is the normal case); the same-origin rule keeps that from becoming a
 * way to reach them from outside.
 */
import * as dns from "node:dns/promises";
import * as net from "node:net";

import { Agent } from "undici";

/** Wire-level cap. Read stops here even if the server keeps sending. */
const MAX_RESPONSE_BYTES = 5_000_000;

/** Cap on the decoded text handed back, before the spill extension sees it. */
const MAX_TEXT_CHARS = 300_000;

/** A URL longer than this is a payload, not an address. */
const MAX_URL_CHARS = 2_048;

const MAX_REDIRECTS = 5;

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Whether a RESOLVED address is one we refuse to talk to. 169.254.169.254 is
 * where cloud providers serve instance credentials to any HTTP client on the
 * host. It takes an IP, never a hostname: `[::ffff:169.254.169.254]` normalizes
 * to hex with no dotted quad to match, and any DNS name can point at the
 * metadata IP (`metadata.google.internal` does).
 */
export function isBlockedAddress(address: string): boolean {
  const ip = unmapIpv4(address.replace(/^\[|\]$/g, "").toLowerCase());

  // IPv4 link-local, including the metadata address.
  if (ip.startsWith("169.254.")) return true;
  // IPv6 link-local: fe80::/10 (fe80–febf).
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
  // IPv6 unique-local: fc00::/7 (fc00–fdff), which covers the fd00:ec2::254
  // form of the metadata address.
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

  return false;
}

/**
 * Unwrap an IPv4-mapped IPv6 address: `::ffff:a9fe:a9fe` and
 * `::ffff:169.254.169.254` both route to 169.254.169.254, so the range checks
 * have to see the dotted quad.
 */
function unmapIpv4(ip: string): string {
  const hexPair = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexPair != null) {
    const high = Number.parseInt(hexPair[1]!, 16);
    const low = Number.parseInt(hexPair[2]!, 16);

    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  const dotted = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);

  return dotted != null ? dotted[1]! : ip;
}

/**
 * Resolve a hostname and refuse it if ANY address it answers with is blocked.
 * Returns the vetted addresses so the caller dials them directly: a zero-TTL
 * name could otherwise answer harmlessly for the check and with the metadata
 * address for the connection.
 */
async function resolveAndVet(url: URL): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // A literal needs no lookup — it is already the address that will be dialed.
  if (net.isIP(host) !== 0) {
    if (isBlockedAddress(host)) {
      throw new WebFetchError(
        "BLOCKED_URL",
        `Refusing to fetch ${url.hostname} — it is a link-local address, ` +
          `the range that serves cloud instance credentials.`
      );
    }

    return [host];
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (error) {
    throw new WebFetchError(
      "NETWORK",
      `Could not resolve ${host}: ${(error as Error).message}`
    );
  }

  if (resolved.length === 0) {
    throw new WebFetchError("NETWORK", `${host} resolved to no addresses.`);
  }

  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new WebFetchError(
        "BLOCKED_URL",
        `Refusing to fetch ${host} — it resolves to ${address}, a link-local ` +
          `address in the range that serves cloud instance credentials.`
      );
    }
  }

  return resolved.map((entry) => entry.address);
}

export interface FetchResult {
  status: number;
  url: string;
  contentType: string;
  text: string;
  truncated: boolean;
  redirects: string[];
}

export class WebFetchError extends Error {
  constructor(
    readonly code:
      | "INVALID_URL"
      | "BLOCKED_URL"
      | "REDIRECT_BLOCKED"
      | "TOO_LARGE"
      | "BINARY"
      | "TIMEOUT"
      | "NETWORK",
    message: string
  ) {
    super(message);
    this.name = "WebFetchError";
  }
}

function parseAndValidate(raw: string): URL {
  if (raw.length > MAX_URL_CHARS) {
    throw new WebFetchError(
      "INVALID_URL",
      `URL is longer than ${MAX_URL_CHARS} characters.`
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebFetchError("INVALID_URL", `Not a valid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError(
      "BLOCKED_URL",
      `Only http and https are supported; refused ${url.protocol}. ` +
        `Use the read tool for local files.`
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new WebFetchError(
      "BLOCKED_URL",
      "Refusing to send credentials embedded in a URL."
    );
  }

  return url;
}

/** Same scheme, host and port. A redirect anywhere else needs a fresh call. */
function sameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.host === b.host;
}

/**
 * A crude HTML-to-text pass, deliberately not a parser: a dependency-free strip
 * is enough for prose. Script and style bodies are dropped entirely.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Content types worth decoding as text. Everything else is refused. */
function isTextual(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

  return (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/xhtml+xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}

/**
 * The `connect.lookup` slot undici hands to Node. Declared here rather than
 * imported: undici exports it only through a `connector` type this repo
 * resolves two copies of, and the runtime contract is Node's, not undici's.
 */
type LookupFunction = (
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address: never, family?: number) => void
) => void;

/** `fetch failed` plus whatever undici actually hit, when it left a cause. */
function describeFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error ? (error.cause as Error | undefined) : undefined;
  if (cause?.message == null || cause.message === message) return message;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return `${message} (${cause.message}${code != null ? `, ${code}` : ""})`;
}

/**
 * The pinned replacement for DNS resolution, in the shape Node actually calls.
 * Node's `lookup` has two conventions chosen by the caller: with `options.all`
 * it wants `(err, [{ address, family }])`, otherwise `(err, address, family)`.
 * undici asks for `all`; answering with the bare string makes every request
 * die with ERR_INVALID_IP_ADDRESS, surfacing as a flat "fetch failed".
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  const lookup = (
    _hostname: string,
    options: { all?: boolean } | undefined,
    callback: (error: Error | null, address: never, family?: number) => void
  ): void => {
    const first = addresses[0];
    if (first == null) {
      callback(
        new Error("No vetted address to connect to"),
        undefined as never
      );
      return;
    }
    if (options?.all === true) {
      // Every vetted address, not just the first: a host with both AAAA and A
      // records (`localhost`) otherwise dies when nothing listens on the first
      // family. The pinning is about WHICH addresses are allowed, not how many.
      callback(
        null,
        addresses.map((address) => ({
          address,
          family: net.isIPv6(address) ? 6 : 4,
        })) as never
      );
      return;
    }
    callback(null, first as never, net.isIPv6(first) ? 6 : 4);
  };

  return lookup as LookupFunction;
}

export async function fetchUrl(
  rawUrl: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<FetchResult> {
  let url = parseAndValidate(rawUrl);
  const redirects: string[] = [];

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  const onOuterAbort = (): void => controller.abort();
  // An already-aborted signal never fires `abort`; a listener alone would let
  // the fetch run the full timeout after the user pressed Stop.
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  // One dispatcher alive at a time, always closed in the finally below: an
  // unclosed Agent leaks its keep-alive pool in a process that runs for days.
  let pinned: Agent | undefined;

  try {
    for (let hop = 0; ; hop++) {
      // Vet before dialing, at every hop: a redirect target gets the same
      // treatment as a URL the model typed.
      const addresses = await resolveAndVet(url);
      // A redirect chain must not accumulate live pools either.
      if (pinned != null) await pinned.close();
      pinned = new Agent({
        connect: {
          // Dial the address the check approved rather than resolving again,
          // which is the trick behind DNS rebinding.
          lookup: pinnedLookup(addresses),
        },
      });

      let response: Response;
      try {
        // Cast at the boundary: `dispatcher` is an undici extension the DOM
        // RequestInit type does not carry, and Node's fetch is undici.
        const init = {
          dispatcher: pinned,
          // Inspected rather than followed, so the same-origin rule applies to
          // each hop.
          redirect: "manual",
          signal: controller.signal,
          headers: {
            // Identify honestly, so rate limits and abuse reports land here.
            "user-agent":
              "AbacusAIBot/1.0 (+https://github.com/abacusai/abacusai-bot)",
            accept:
              "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1",
          },
        };

        response = await fetch(url, init as unknown as RequestInit);
      } catch (error) {
        if ((error as Error).name === "AbortError") {
          throw new WebFetchError("TIMEOUT", `Timed out fetching ${url.href}`);
        }
        // undici reports every dial failure as a flat "fetch failed" with the
        // real reason on `cause`; dropping it turns a client bug into "site down".
        throw new WebFetchError(
          "NETWORK",
          `Could not reach ${url.href}: ${describeFetchError(error)}`
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location == null) {
          throw new WebFetchError(
            "NETWORK",
            `${url.href} redirected without a destination.`
          );
        }
        if (hop >= MAX_REDIRECTS) {
          throw new WebFetchError(
            "REDIRECT_BLOCKED",
            `More than ${MAX_REDIRECTS} redirects from ${rawUrl}.`
          );
        }

        const next = parseAndValidate(new URL(location, url).href);

        // Check the destination before the origin rule: the cross-origin
        // message invites the model to call again with the destination, which
        // is the last advice to give about a link-local address.
        const nextHost = next.hostname.replace(/^\[|\]$/g, "");
        if (net.isIP(nextHost) !== 0 && isBlockedAddress(nextHost)) {
          throw new WebFetchError(
            "BLOCKED_URL",
            `${url.href} redirects to ${next.hostname}, a link-local address in ` +
              `the range that serves cloud instance credentials. Refused.`
          );
        }

        if (!sameOrigin(url, next)) {
          throw new WebFetchError(
            "REDIRECT_BLOCKED",
            `${url.href} redirects to a different origin (${next.origin}). ` +
              `Cross-origin redirects are not followed — call web_fetch again with ` +
              `${next.href} if that is where you meant to go.`
          );
        }

        redirects.push(next.href);
        url = next;
        // Drop the 3xx body before the next hop: a body larger than the stream
        // buffer would leave the graceful `pinned.close()` waiting on it until
        // the timeout.
        await response.body?.cancel().catch(() => {});
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";

      // A 404 is a result the model can use; only transport failures are
      // errors. Status does not gate the binary guard, though: a 500 carrying
      // image/png would still decode into mojibake.
      if (!isTextual(contentType) && contentType !== "") {
        // An unread stream keeps the request in flight, and the graceful close
        // below would wait on it forever.
        await response.body?.cancel().catch(() => {});
        throw new WebFetchError(
          "BINARY",
          `${url.href} returned ${contentType}, which is not text. ` +
            `Download it with bash if you need the file itself.`
        );
      }

      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new WebFetchError(
          "TOO_LARGE",
          `${url.href} is ${declared} bytes, over the ${MAX_RESPONSE_BYTES} byte cap.`
        );
      }

      // Read incrementally so a server that lies about content-length still
      // cannot stream unbounded data into the process.
      const body = response.body;
      let raw = "";
      let bytes = 0;
      let truncated = false;

      if (body != null) {
        const reader = body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: false });
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value != null) {
              bytes += value.byteLength;
              if (bytes > MAX_RESPONSE_BYTES) {
                truncated = true;
                break;
              }
              raw += decoder.decode(value, { stream: true });
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }

      let text = /html/i.test(contentType) ? htmlToText(raw) : raw;
      if (text.length > MAX_TEXT_CHARS) {
        text = text.slice(0, MAX_TEXT_CHARS);
        truncated = true;
      }

      return {
        status: response.status,
        url: url.href,
        contentType,
        text,
        truncated,
        redirects,
      };
    }
  } catch (error) {
    // An unread body counts as in flight and graceful close waits for it, so
    // tear the sockets down instead.
    if (pinned != null) await pinned.destroy().catch(() => {});
    pinned = undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
    // Never leave a dispatcher and its keep-alive sockets behind.
    if (pinned != null) await pinned.close();
  }
}
