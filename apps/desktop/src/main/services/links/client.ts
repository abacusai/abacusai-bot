import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";

/** URL normalisation happens before IP parsing, including legacy numeric IPv4 forms. */
export const publicAddress = (address: string): boolean => {
  try {
    const ip = ipaddr.process(address.replace(/^\[|\]$/g, ""));
    // An allowlist excludes unspecified, mapped private IPv4, ULA, CGNAT,
    // multicast, link-local, documentation and reserved networks.
    return ip.range() === "unicast";
  } catch {
    return false;
  }
};

export const previewUrl = (input: string): URL => {
  if (input.length > 4096) throw new Error("Preview URL limit");
  const url = new URL(input);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "local" ||
    host.endsWith(".local")
  )
    throw new Error("Refused preview target");
  if (ipaddr.isValid(host.replace(/^\[|\]$/g, "")) && !publicAddress(host))
    throw new Error("Refused preview address");
  url.hash = "";
  return url;
};

export interface Resource {
  body: Buffer;
  url: string;
  type: string;
}
export type Resolve = (
  host: string
) => Promise<Array<{ address: string; family: number }>>;

/** Each hop uses fresh DNS, a single pinned address and a new, non-pooled socket. */
export class PreviewClient {
  private active = 0;
  private readonly hosts = new Map<string, { at: number; count: number }>();
  constructor(
    private readonly resolve: Resolve = (host) =>
      lookup(host, { all: true, verbatim: true })
  ) {}

  async fetch(
    input: string,
    kind: "html" | "image",
    signal: AbortSignal,
    redirects = 0
  ): Promise<Resource> {
    signal.throwIfAborted();
    const url = previewUrl(input);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const budget = this.hosts.get(hostname);
    const now = Date.now();
    const count = budget && now - budget.at < 60_000 ? budget.count : 0;
    if (this.active >= 4 || count >= 12)
      throw new Error("Preview request budget");
    this.hosts.delete(hostname);
    this.hosts.set(hostname, {
      at: count ? budget!.at : now,
      count: count + 1,
    });
    while (this.hosts.size > 200)
      this.hosts.delete(this.hosts.keys().next().value!);
    this.active++;
    let released = false;
    try {
      const addresses = await this.resolve(hostname);
      signal.throwIfAborted();
      if (
        !addresses.length ||
        addresses.some(({ address }) => !publicAddress(address))
      )
        throw new Error("Refused DNS answer");
      const pinned = addresses[0]!;
      const pinnedLookup: LookupFunction = (_host, options, callback) => {
        if (!publicAddress(pinned.address))
          return callback(new Error("Refused address"), "", 0);
        if (options.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      };
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          const request = (url.protocol === "https:" ? https : http).request(
            url,
            {
              agent: false,
              lookup: pinnedLookup,
              signal,
              headers: {
                "user-agent": "LinkPreview/1.0",
                accept: kind === "html" ? "text/html" : "image/*",
                "accept-encoding": "identity",
              },
            },
            resolve
          );
          request.on("socket", (socket) => {
            socket.once("connect", () => {
              const address = socket.remoteAddress;
              if (
                address == null ||
                !publicAddress(address) ||
                ipaddr.process(address).toString() !==
                  ipaddr.process(pinned.address).toString()
              )
                request.destroy(new Error("Refused connected address"));
            });
          });
          request.once("error", reject);
          request.end();
        }
      );
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        if (redirects >= 3 || !response.headers.location)
          throw new Error("Redirect limit");
        // The old response is closed before the next hop starts.
        this.active--;
        released = true;
        return await this.fetch(
          new URL(response.headers.location, url).href,
          kind,
          signal,
          redirects + 1
        );
      }
      const type = (response.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      const cap = kind === "html" ? 512 * 1024 : 1024 * 1024;
      if (
        status !== 200 ||
        (kind === "html" ? type !== "text/html" : !type.startsWith("image/")) ||
        (response.headers["content-encoding"] ?? "identity") !== "identity" ||
        Number(response.headers["content-length"] ?? 0) > cap
      ) {
        response.destroy();
        throw new Error("Refused response");
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        signal.throwIfAborted();
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > cap) {
          response.destroy();
          throw new Error("Response limit");
        }
        chunks.push(buffer);
      }
      return { body: Buffer.concat(chunks), url: url.href, type };
    } finally {
      if (!released) this.active--;
    }
  }
}
