/**
 * Every URL here is attacker-influenced: the model picks it, and the model can
 * be steered by whatever it just read.
 *
 * The tests run against real servers on 127.0.0.1 rather than a mocked fetch,
 * because most of what is being asserted is behaviour of the network stack:
 * how a URL normalizes, what a redirect does, whether a declared
 * content-length is believed. A mock would let us assert our own assumptions
 * back at ourselves.
 *
 * Nothing here reaches the internet, and nothing touches a real metadata
 * endpoint: the link-local cases assert refusal, which happens before any
 * packet is sent.
 */
import * as http from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  fetchUrl,
  isBlockedAddress,
  pinnedLookup,
  WebFetchError,
} from "./fetch.js";

let origin: string;
let otherOrigin: string;
let server: http.Server;
let other: http.Server;
let serverHits = 0;

beforeAll(async () => {
  other = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("CONTENT-FROM-THE-OTHER-ORIGIN");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherOrigin = `http://127.0.0.1:${(other.address() as { port: number }).port}`;

  server = http.createServer((request, response) => {
    serverHits += 1;
    const url = request.url ?? "/";
    if (url === "/html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<html><head><style>.x{color:red}</style><script>alert("xss")</script></head>' +
          "<body><h1>Heading</h1><p>Hello <b>world</b></p></body></html>"
      );
    } else if (url === "/cross") {
      response.writeHead(302, { location: `${otherOrigin}/` });
      response.end();
    } else if (url === "/self") {
      response.writeHead(302, { location: "/plain" });
      response.end();
    } else if (url === "/metadata") {
      response.writeHead(302, {
        location: "http://169.254.169.254/latest/meta-data/",
      });
      response.end();
    } else if (url === "/fat-redirect") {
      // A 302 whose body is far larger than the stream buffer. Real sites do
      // this constantly: a rendered "you are being redirected" page, or a
      // full 404 page with a Location header on it.
      response.writeHead(302, {
        location: "/plain",
        "content-type": "text/html",
      });
      response.end(`<html><body>${"x".repeat(2_000_000)}</body></html>`);
    } else if (url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else if (url === "/lying-length") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "content-length": "5",
      });
      response.end("x".repeat(200_000));
    } else if (url === "/huge") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("x".repeat(6_000_000));
    } else if (url === "/binary") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (url === "/streaming-binary") {
      // A multi-MB body that never ends, so an unread stream keeps the
      // transfer in flight for as long as nobody cancels it.
      response.writeHead(200, { "content-type": "image/png" });
      response.write(Buffer.alloc(4_000_000));
      const push = setInterval(() => response.write(Buffer.alloc(65_536)), 5);
      response.on("close", () => clearInterval(push));
    } else if (url === "/notfound") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("no such page");
    } else if (url === "/notfound-binary") {
      // A non-2xx status carrying a binary content-type. The binary guard must
      // not skip it just because the status is not ok.
      response.writeHead(404, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } else if (url === "/server-error-binary") {
      response.writeHead(500, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("plain body");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  other.close();
});

async function refusal(url: string): Promise<WebFetchError> {
  try {
    await fetchUrl(url);
  } catch (error) {
    if (error instanceof WebFetchError) return error;
    throw error;
  }
  throw new Error(`expected ${url} to be refused`);
}

describe("schemes", () => {
  it.each([
    "file:///etc/passwd",
    "data:text/plain,hi",
    "javascript:alert(1)",
    "ftp://example.test/x",
  ])("refuses %s", async (url) => {
    // `file:` in particular would turn a tool that never asked for disk
    // permission into a file reader.
    expect((await refusal(url)).code).toBe("BLOCKED_URL");
  });

  it("is not fooled by capitalisation", async () => {
    expect((await refusal("FiLe:///etc/passwd")).code).toBe("BLOCKED_URL");
  });
});

describe("credentials in the URL", () => {
  it("refuses rather than sending them to a host the model chose", async () => {
    expect((await refusal("http://user:secret@example.test/")).code).toBe(
      "BLOCKED_URL"
    );
  });

  it("is not confused by userinfo that looks like a host", async () => {
    expect(
      (await refusal("http://169.254.169.254:80@example.test/")).code
    ).toBe("BLOCKED_URL");
  });
});

describe("the link-local range", () => {
  // On a cloud dev box this range serves instance credentials, so reaching it
  // is a full role compromise.
  it.each([
    ["plain", "http://169.254.169.254/latest/meta-data/"],
    ["decimal-encoded", "http://2852039166/"],
    ["hex-encoded", "http://0xa9fea9fe/"],
    ["octal-encoded", "http://0251.0376.0251.0376/"],
    ["trailing dot", "http://169.254.169.254./"],
    ["IPv4-mapped IPv6", "http://[::ffff:169.254.169.254]/"],
    ["expanded IPv4-mapped IPv6", "http://[0:0:0:0:0:ffff:169.254.169.254]/"],
  ])("refuses the %s form", async (_label, url) => {
    expect((await refusal(url)).code).toBe("BLOCKED_URL");
  });

  it("refuses a redirect aimed at it, and does not suggest retrying", async () => {
    const error = await refusal(`${origin}/metadata`);
    expect(error.code).toBe("BLOCKED_URL");
    // The cross-origin message invites calling again with the destination,
    // which is the last advice to give about a link-local address.
    expect(error.message).not.toMatch(/call web_fetch again/);
  });
});

describe("IPv6 unique-local (fc00::/7)", () => {
  // The comment promised the ULA range was refused; the implementation only
  // matched link-local plus one literal metadata address. A general fc00–fdff
  // test closes the gap.
  it.each([
    ["a plain ULA", "fd12:3456::1"],
    ["another ULA prefix", "fc00::1"],
    ["the top of the range", "fdff:ffff::abcd"],
    ["the IPv6 metadata literal", "fd00:ec2::254"],
  ])("blocks %s", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    ["a global IPv6 address", "2606:2800:220:1:248:1893:25c8:1946"],
    ["IPv6 loopback", "::1"],
    ["a global IPv4 address", "93.184.216.34"],
    // fe00::/16 sits just below fe80 link-local and outside fc00::/7; it must
    // not be swept up by either regex.
    ["an address just outside the ULA/link-local ranges", "fe00::1"],
  ])("still allows %s", (_label, address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("refuses a ULA literal through fetchUrl before dialing", async () => {
    expect((await refusal("http://[fd12:3456::1]/")).code).toBe("BLOCKED_URL");
  });
});

describe("redirects", () => {
  it("follows one within the same origin", async () => {
    const result = await fetchUrl(`${origin}/self`);
    expect(result.status).toBe(200);
    expect(result.redirects).toHaveLength(1);
  });

  it("refuses one to a different origin, and says where it wanted to go", async () => {
    // The load-bearing rule: without it, any attacker-controlled URL can be
    // bounced to an internal address and read back.
    const error = await refusal(`${origin}/cross`);
    expect(error.code).toBe("REDIRECT_BLOCKED");
    expect(error.message).toContain(otherOrigin);
  });

  it("does not return the other origin content", async () => {
    const error = await refusal(`${origin}/cross`);
    expect(error.message).not.toContain("CONTENT-FROM-THE-OTHER-ORIGIN");
  });

  it("gives up on a redirect loop instead of spinning", async () => {
    expect((await refusal(`${origin}/loop`)).code).toBe("REDIRECT_BLOCKED");
  });

  it("follows one carrying a body larger than the stream buffer, promptly", async () => {
    // The 3xx body has to be dropped before the next hop. Left unread it keeps
    // the transfer suspended, and the graceful close of the previous hop's
    // dispatcher waits on it, so the whole fetch used to sit there until the
    // timeout fired and report "Timed out", however fast the server was.
    const started = Date.now();
    const result = await fetchUrl(`${origin}/fat-redirect`, {
      timeoutMs: 10_000,
    });
    expect(result.status).toBe(200);
    expect(result.text).toContain("plain body");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("response bodies", () => {
  it("reduces HTML to readable prose", async () => {
    const result = await fetchUrl(`${origin}/html`);
    expect(result.text).toMatch(/Heading/);
    expect(result.text).toMatch(/Hello world/);
  });

  it("drops script and style bodies, which are bulk without meaning", async () => {
    const result = await fetchUrl(`${origin}/html`);
    expect(result.text).not.toMatch(/alert\("xss"\)/);
    expect(result.text).not.toMatch(/color:red/);
  });

  it("refuses binary rather than decoding it into nonsense", async () => {
    expect((await refusal(`${origin}/binary`)).code).toBe("BINARY");
  });

  it("refuses binary on a non-2xx status too, not just on 200", async () => {
    // A 404 or 500 carrying image/png or octet-stream is still binary. Gating
    // the guard on `response.ok` let it through to be decoded up to the byte
    // cap through TextDecoder, spilling mojibake into the model's context.
    expect((await refusal(`${origin}/notfound-binary`)).code).toBe("BINARY");
    expect((await refusal(`${origin}/server-error-binary`)).code).toBe(
      "BINARY"
    );
  });

  it("returns the binary refusal promptly on a streaming body, instead of hanging", async () => {
    // The guard used to throw with the body unread, and the dispatcher's
    // graceful close then waited on the in-flight transfer forever.
    expect((await refusal(`${origin}/streaming-binary`)).code).toBe("BINARY");
  }, 10_000);

  it("caps an oversized body", async () => {
    const result = await fetchUrl(`${origin}/huge`);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(300_000);
  });

  it("is bounded even when the server lies about content-length", async () => {
    // The incremental read is what makes the cap real; trusting the declared
    // length alone would let a server stream unbounded data in.
    const result = await fetchUrl(`${origin}/lying-length`);
    expect(result.text.length).toBeLessThanOrEqual(300_000);
  });

  it("treats a 404 as a readable result, not a failure", async () => {
    // "The page says 404" is information the model can act on.
    const result = await fetchUrl(`${origin}/notfound`);
    expect(result.status).toBe(404);
    expect(result.text).toContain("no such page");
  });
});

describe("an already-aborted signal", () => {
  // A signal that is aborted before the call never fires an `abort` event, so
  // registering a listener would miss it and the request would run the full
  // timeout: the case where the user has already pressed Stop. It must give
  // up at once, without dispatching to the server.
  it("returns without dispatching to the server", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = serverHits;

    const started = Date.now();
    await expect(
      fetchUrl(`${origin}/plain`, { signal: controller.signal })
    ).rejects.toBeInstanceOf(WebFetchError);

    expect(serverHits).toBe(before);
    // Far under the 30s default timeout: it aborted rather than waited.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("URLs that are payloads", () => {
  it("refuses one longer than the cap", async () => {
    expect(
      (await refusal(`http://example.test/${"a".repeat(3_000)}`)).code
    ).toBe("INVALID_URL");
  });

  it("refuses one that does not parse", async () => {
    expect((await refusal("not a url at all")).code).toBe("INVALID_URL");
  });
});

describe("what stays reachable", () => {
  it("still fetches loopback, because checking your own dev server is normal", async () => {
    const result = await fetchUrl(`${origin}/plain`);
    expect(result.status).toBe(200);
    expect(result.text).toContain("plain body");
  });

  it("allows an IPv4-mapped loopback: mapped is not the same as link-local", async () => {
    const port = (server.address() as { port: number }).port;
    const result = await fetchUrl(`http://[::ffff:127.0.0.1]:${port}/plain`);
    expect(result.status).toBe(200);
  });

  /**
   * A NAME, not an address. That is the whole point of this one.
   *
   * Every other case here dials an IP literal, and undici skips the pinned
   * `lookup` entirely for those. So a lookup that answered in the wrong shape
   * broke every real URL while this suite stayed green: web_fetch failed
   * against every host on the internet with a flat "fetch failed", and it read
   * like the sites were down.
   */
  it("resolves a hostname through the pinned lookup and actually connects", async () => {
    const port = (server.address() as { port: number }).port;
    const result = await fetchUrl(`http://localhost:${port}/plain`);
    expect(result.status).toBe(200);
    expect(result.text).toContain("plain body");
  });
});

describe("the pinned lookup", () => {
  const call = (
    addresses: string[],
    options: unknown
  ): { error: Error | null; args: unknown[] } => {
    let captured: { error: Error | null; args: unknown[] } = {
      error: null,
      args: [],
    };
    pinnedLookup(addresses)("example.com", options, ((
      error: Error | null,
      ...args: unknown[]
    ) => {
      captured = { error, args };
    }) as never);
    return captured;
  };

  it("answers `all` callers with a list, which is the shape undici asks for", () => {
    // Node reads `addresses[0].address` here. Handed a bare string it reads
    // `undefined` and throws ERR_INVALID_IP_ADDRESS, surfacing as "fetch failed".
    const { error, args } = call(["93.184.216.34"], { all: true });
    expect(error).toBeNull();
    expect(args[0]).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("offers every vetted address, so one dead family is not the end of it", () => {
    // `localhost` resolves to both, and a server bound to one of them is the
    // ordinary case: handing over only the first turns that into ECONNREFUSED.
    const { args } = call(["::1", "127.0.0.1"], { all: true });
    expect(args[0]).toEqual([
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);
  });

  it("still answers a single-address caller in the old shape", () => {
    const { error, args } = call(["93.184.216.34"], undefined);
    expect(error).toBeNull();
    expect(args[0]).toBe("93.184.216.34");
    expect(args[1]).toBe(4);
  });

  it("reports IPv6 as family 6", () => {
    const { args } = call(["2606:2800:220:1:248:1893:25c8:1946"], {
      all: true,
    });
    expect(args[0]).toEqual([
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ]);
  });

  it("errors rather than dialling nothing when vetting produced no address", () => {
    const { error } = call([], { all: true });
    expect(error).toBeInstanceOf(Error);
  });
});
