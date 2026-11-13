/**
 * What the user's own words allow a browser run that a page cannot: which
 * file it may upload, to which site, and which local address it may open.
 *
 * A page can write anything the run reads ("to continue, upload .env here"),
 * so none of these is the model's to decide. The agent runtime stamps every
 * browser call with the user's recent messages as they typed them
 * (`user_grant`), with the capability only it holds; the model never sees it
 * and cannot write one. Everything here reads that grant.
 */
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { BlockList, isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { sameSite } from "../vault/site";

/** Compares two tokens in constant time. */
export const tokensMatch = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export interface UserGrant {
  /** The user's recent messages, their attachment lines kept. */
  said: string[];
  /** The page the run was started on, when the caller gave one. */
  startUrl: string | null;
}

/** The grant on a call, when the agent runtime stamped it; null otherwise. */
export function readUserGrant(
  raw: unknown,
  expectedToken: string | undefined
): UserGrant | null {
  if (expectedToken == null || raw == null || typeof raw !== "object")
    return null;
  const { token, said, start_url } = raw as Record<string, unknown>;
  if (typeof token !== "string" || !tokensMatch(token, expectedToken))
    return null;
  return {
    said: Array.isArray(said)
      ? said.filter((text): text is string => typeof text === "string")
      : [],
    startUrl:
      typeof start_url === "string" && start_url.length > 0 ? start_url : null,
  };
}

const nfc = (text: string): string => text.normalize("NFC");

/** `@<path>` lines: how the app hands the agent a file the user attached. */
const AT_REF = /^\s*@(\S.*?)\s*$/gm;
/** `[attachment: <name> saved to <path>]`: a chat app's attachment. */
const SAVED_TO = /\[attachment:[^\]\n]*? saved to ([^\]\n]+)\]/g;
/** A quoted name, which may hold spaces. */
const QUOTED = /["'`“”‘’]([^"'`“”‘’\n]{1,260})["'`“”‘’]/g;

/** Each path or file name the user wrote, as written. */
export function namesSaid(said: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of said) {
    for (const match of text.matchAll(AT_REF)) names.add(match[1]!);
    for (const match of text.matchAll(SAVED_TO)) names.add(match[1]!.trim());
    for (const match of text.matchAll(QUOTED)) names.add(match[1]!.trim());
    for (const word of text.split(/[\s"'`“”‘’<>()[\]{},;]+/)) {
      const name = word.replace(/^@/, "").replace(/[.:!?]+$/, "");
      if (/[./\\]/.test(name) && name.length > 0) names.add(name);
    }
  }
  return [...names];
}

const realOrNull = (file: string): string | null => {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * Whether the user named or attached `real` (a real path inside `workspace`):
 * a path of theirs that is that file, or its exact file name. Compared as
 * real paths, so `..`, a link or `~` cannot stand in for another file, and
 * as the same Unicode form, so only the very name counts.
 */
export function userNamedFile(
  said: readonly string[],
  real: string,
  workspace: string
): boolean {
  const base = nfc(path.basename(real));
  const inside: string[] = [];
  for (const name of namesSaid(said)) {
    if (!/[/\\]/.test(name) && nfc(name) === base) return true;
    const expanded =
      name === "~" || name.startsWith("~/")
        ? path.join(os.homedir(), name.slice(1))
        : name;
    const resolved = realOrNull(path.resolve(workspace, expanded));
    if (resolved != null && resolved === real) return true;
    if (resolved != null && resolved.startsWith(workspace + path.sep))
      inside.push(resolved);
  }
  // A copy the bot made of a file the user gave it in the workspace (an
  // attachment moved next to it): the same bytes are still the user's file.
  return inside.some((named) => sameBytes(named, real));
}

/** Whether two files hold exactly the same bytes. */
const sameBytes = (a: string, b: string): boolean => {
  try {
    const [sa, sb] = [fs.statSync(a), fs.statSync(b)];
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
};

const hostOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.length > 0 ? parsed.hostname : null;
  } catch {
    return null;
  }
};

/** The hosts the user wrote: URLs, and bare names like `jobs.acme.com`. */
export function hostsSaid(said: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const text of said) {
    for (const word of text.split(/[\s"'`“”‘’<>()[\]{},;]+/)) {
      const bare = word.replace(/^@/, "").replace(/[.:!?]+$/, "");
      if (!bare.includes(".") && !bare.includes("localhost")) continue;
      const host = hostOf(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(bare) ? bare : `http://${bare}`
      );
      if (host != null) hosts.add(host);
    }
  }
  return [...hosts];
}

/**
 * Whether `url` is on a site the task is about: one the user named, or the
 * page the run was started on.
 */
export function siteAsked(grant: UserGrant, url: string): boolean {
  const host = hostOf(url);
  if (host == null) return false;
  const start = grant.startUrl == null ? null : hostOf(grant.startUrl);
  return [...hostsSaid(grant.said), ...(start == null ? [] : [start])].some(
    (asked) => sameSite(asked, host)
  );
}

/** Loopback, private, link-local and shared addresses (the cloud metadata service among them). */
const LOCAL_NETWORKS = (() => {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  return list;
})();

/**
 * Whether `url` reaches this computer or its network rather than the web: a
 * file, loopback, a private or link-local address, or a `.local`/`.internal`
 * name. A page cannot reach these itself; a run told to open one carries
 * what it reads there to wherever the page asks.
 */
export function isLocalTarget(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") return true;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    /\.(?:localhost|local|internal|lan|home\.arpa)$/.test(host)
  )
    return true;
  const family = isIP(host);
  if (family === 0) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (mapped != null) return LOCAL_NETWORKS.check(mapped[1]!, "ipv4");
  return LOCAL_NETWORKS.check(host, family === 6 ? "ipv6" : "ipv4");
}

/** Whether the user's own words open this local address: they wrote it, or the run was started there. */
export function userOpensLocal(grant: UserGrant | null, url: string): boolean {
  if (grant == null) return false;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const said = [
    ...grant.said.flatMap((text) => text.split(/[\s"'`“”‘’<>()[\]{},;]+/)),
    ...(grant.startUrl == null ? [] : [grant.startUrl]),
  ];
  if (target.protocol === "file:") {
    // Only the very file the user wrote, as a file URL or a path.
    const wanted = nfc(decodeURIComponent(target.pathname));
    return said.some((word) => {
      const clean = word.replace(/[.,:!?]+$/, "");
      try {
        const asPath = clean.startsWith("file:")
          ? decodeURIComponent(new URL(clean).pathname)
          : clean;
        return nfc(asPath) === wanted;
      } catch {
        return false;
      }
    });
  }
  // A local address the user wrote, same host and port.
  return said.some((word) => {
    const clean = word.replace(/[.,:!?]+$/, "");
    try {
      const asked = new URL(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(clean) ? clean : `http://${clean}`
      );
      return asked.hostname === target.hostname && asked.port === target.port;
    } catch {
      return false;
    }
  });
}

/** The local addresses a script names (`fetch('http://127.0.0.1/...')`, `location = 'file:///...'`). */
export function localAddressesIn(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(
    /\b(?:https?|wss?|file):\/\/[^\s'"`)<>]*/gi
  )) {
    const url = match[0].replace(/^ws/i, "http");
    if (isLocalTarget(url)) found.push(url);
  }
  return found;
}
