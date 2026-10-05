/**
 * The host transport's procedure kinds (spec 09 D2) match the contract:
 * every query and subscription is a read, every mutation a write, and the
 * named exceptions are mutations. A stream consumer census: every
 * subscription the renderer opens is reopened on a new socket.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { contract } from "@abacus-ai/contract/contract";
import { expect, it } from "vitest";

import { policyOf, readProcedures } from "./intent";

type Kind = "query" | "mutation" | "subscription";

const procedures = (): Map<string, Kind> => {
  const out = new Map<string, Kind>();
  const walk = (node: unknown, path: string[]): void => {
    const orpc = (node as { "~orpc"?: { meta?: { kind?: Kind } } })["~orpc"];
    if (orpc != null) {
      out.set(path.join("."), orpc.meta?.kind ?? "mutation");
      return;
    }
    for (const [key, child] of Object.entries(node as object))
      walk(child, [...path, key]);
  };
  walk(contract, []);
  return out;
};

it("lists exactly the contract's queries and subscriptions as reads", () => {
  const reads = [...procedures()]
    .filter(([, kind]) => kind !== "mutation")
    .map(([path]) => path)
    .sort();
  expect([...readProcedures()].sort()).toEqual(reads);
});

it("holds every mutation for authorization except the host's idle clock", () => {
  for (const [path, kind] of procedures()) {
    const policy = policyOf(path.split("."));
    if (kind !== "mutation")
      expect(policy, path).toEqual({ authorize: false, deadline: false });
    else if (path === "system.activity")
      expect(policy).toEqual({ authorize: false, deadline: true });
    else expect(policy.authorize, path).toBe(true);
  }
  expect(policyOf(["bots", "openChat"]).deadline).toBe(false);
  expect(policyOf(["not", "in", "the", "contract"])).toEqual({
    authorize: true,
    deadline: true,
  });
});

/**
 * Files that open a subscription on `transport.client` without
 * `followNotices`, and the loop of their own that survives a replaced
 * socket. (Chat streams go through the pump and DB feeds through the
 * collections, over their own clients: their suites cover reconnects.)
 */
const RECOVERING: Record<string, string> = {
  "features/sessions/terminal/terminal-tab.tsx":
    "terminal.output: pumpOutput reopens from its offset; the call waits for a socket",
  "features/sessions/device/device-tab.tsx":
    "devices.stream.chunks: retried, then the snapshot fallback (desktop only)",
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "fixtures" || name === "test-support"
        ? []
        : sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

it("reopens every stream consumer on a new socket", () => {
  const root = join(__dirname, "..", "..");
  const streams = [...procedures()]
    .filter(([, kind]) => kind === "subscription")
    .map(([path]) => path);
  const unfollowed: string[] = [];
  const opening = new Set<string>();
  for (const file of sources(root)) {
    const text = readFileSync(file, "utf8");
    // Keys in RECOVERING use forward slashes; Windows paths do not.
    const name = relative(root, file).split(sep).join("/");
    for (const stream of streams) {
      const call = new RegExp(`client\\.${stream.replaceAll(".", "\\.")}\\(`);
      if (!call.test(text)) continue;
      opening.add(name);
      if (name in RECOVERING) continue;
      if (text.includes("followNotices(")) continue;
      unfollowed.push(`${name}: ${stream}`);
    }
  }
  expect(unfollowed).toEqual([]);
  // No stale exceptions.
  for (const name of Object.keys(RECOVERING))
    expect(opening.has(name), name).toBe(true);
});
