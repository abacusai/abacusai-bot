/**
 * The SSRF guard on generated-asset downloads.
 *
 * The URL comes back in a provider response, so it is attacker-influenceable,
 * and this fetch runs in the main process — a permissive check turns it into a
 * probe against the desktop's own network: localhost services, the LAN, and
 * 169.254.169.254 for cloud instance credentials.
 *
 * The guard is correct because `new URL()` normalises before it is consulted:
 * 2130706433, 0177.0.0.1, 0x7f.0.0.1 and 127.1 all become 127.0.0.1. That is
 * the property worth pinning — it is invisible in the source, and anyone
 * replacing the parser with hand-rolled string work would silently reopen every
 * one of these.
 */
import { describe, expect, it } from "vitest";

import { assertPublicHttpsUrl } from "./generated-files";

const rejects = (url: string): boolean => {
  try {
    assertPublicHttpsUrl(url);

    return false;
  } catch {
    return true;
  }
};

describe("what it allows", () => {
  it("allows an ordinary public https CDN url", () => {
    expect(rejects("https://cdn.example.com/asset.png")).toBe(false);
    expect(rejects("https://files.provider.co.uk/a/b/c.mp4?sig=abc")).toBe(
      false
    );
  });
});

describe("what it refuses outright", () => {
  it("refuses anything that is not https", () => {
    // Downgrading to http would make the fetch interceptable as well as
    // pointing it anywhere.
    expect(rejects("http://cdn.example.com/a.png")).toBe(true);
    expect(rejects("file:///etc/passwd")).toBe(true);
    expect(rejects("ftp://cdn.example.com/a")).toBe(true);
  });

  it("refuses a url it cannot parse", () => {
    expect(rejects("not a url")).toBe(true);
    expect(rejects("")).toBe(true);
  });

  it("refuses loopback and private hosts by name", () => {
    for (const url of [
      "https://localhost/a",
      "https://api.localhost/a",
      "https://svc.internal/a",
    ]) {
      expect(rejects(url), url).toBe(true);
    }
  });

  it("refuses the private ranges and the metadata address", () => {
    for (const url of [
      "https://127.0.0.1/a",
      "https://10.0.0.5/a",
      "https://192.168.1.1/a",
      "https://172.16.0.1/a",
      "https://172.31.255.255/a",
      "https://169.254.169.254/latest/meta-data", // cloud instance credentials
      "https://0.0.0.0/a",
    ]) {
      expect(rejects(url), url).toBe(true);
    }
  });

  it("refuses bare IPs and IPv6, public ones included", () => {
    // Every provider CDN is a hostname, so refusing all literals costs nothing
    // and removes a whole class of argument about which ranges are private.
    expect(rejects("https://8.8.8.8/a")).toBe(true);
    expect(rejects("https://[::1]/a")).toBe(true);
    expect(rejects("https://[fd00::1]/a")).toBe(true);
  });
});

describe("loopback wearing a different encoding", () => {
  it("refuses every alternate spelling of 127.0.0.1", () => {
    // These are the classic SSRF filter bypasses. They are caught because
    // `new URL()` normalises the host before the guard reads it — not because
    // the guard enumerates them. Replace the parser and these all come back.
    for (const url of [
      "https://2130706433/a", // decimal
      "https://0177.0.0.1/a", // octal
      "https://0x7f.0.0.1/a", // hex
      "https://127.1/a", // short form
    ]) {
      expect(rejects(url), url).toBe(true);
    }
  });

  it("is case-insensitive about the host", () => {
    expect(rejects("https://LOCALHOST/a")).toBe(true);
    expect(rejects("https://API.LocalHost/a")).toBe(true);
  });
});
