/**
 * The shape of `main/` and its `services/`, pinned.
 *
 * This directory reached 71 loose files, which is how it was reported: one flat
 * folder nobody could navigate. Grouping it is only half a fix — the half that
 * lasts is that the next service has somewhere obvious to go, and that dropping
 * one at the top level fails here instead of being noticed a year later.
 *
 * The rule is deliberately about placement, not about count. A group growing
 * large is fine; a file with no group is the thing that does not scale.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SERVICES = import.meta.dirname;

/** The groups a service can belong to. Adding one is a deliberate decision. */
const GROUPS = [
  "agent-tools",
  "bots",
  "browser",
  "config",
  // The connector registry's status table and connect flow — one answer to
  // "is it connected?" and one way to connect, for every kind.
  "connectors",
  "conversation",
  "debug-sync",
  "diagnostics",
  "device",
  "mcp",
  "messaging",
  "pptx",
  "providers",
  "sandbox",
  "session",
  "updates",
  "workspace",
];

/**
 * What `main/` itself may hold: the process entry point, the IPC surface, and
 * the handful of process-level concerns that belong to no service. Everything
 * that serves a feature goes in `services/`.
 */
const MAIN_ROOT_FILES = [
  // The other half of the same question, one process over: what THIS process
  // can resolve from inside the asar. Also no module of its own, and also a
  // process-level concern rather than any one service's.
  "agent-import-surface.test.ts",
  // No module of its own: it is a check on how the app is packaged, and what
  // it checks — what the spawned agent process can resolve beside itself — is
  // a process-level concern rather than any one service's.
  "agent-runtime-deps.test.ts",
  "app-quit-state.ts",
  // The main window's reveal, shared the way the quit flag above is: a service
  // that sends the user to their browser needs them back afterwards, and must
  // not import the entry module to say so.
  "bring-to-front.test.ts",
  "bring-to-front.ts",
  "crash-guard.test.ts",
  "crash-guard.ts",
  "external-links.test.ts",
  "external-links.ts",
  "handler.test.ts",
  "handler.ts",
  "index.ts",
  "keep-awake.ts",
  "local-open-guard.test.ts",
  "local-open-guard.ts",
  // The third process-level check, next to the other two: whether the app the
  // installer produces can load itself at all.
  "packaged-startup.test.ts",
  "pasted-temp-files.test.ts",
  "pasted-temp-files.ts",
  "paths.test.ts",
  "paths.ts",
  // The account-profile home switch. Process-level by necessity: it must run
  // before any module that reads abacusBotHome() loads.
  "profile-home-init.ts",
  "profile-home.test.ts",
  "profile-home.ts",
  "renderer-csp.test.ts",
  "renderer-csp.ts",
  // The main window's renderer view, its swap machinery, and the send-to-
  // renderer registry the services broadcast through.
  "renderer-host.test.ts",
  "renderer-host.ts",
  "resources.ts",
  "service-host.ts",
  "spellcheck-dictionary.ts",
];

const entries = readdirSync(SERVICES, { withFileTypes: true });

describe("the services directory", () => {
  it("holds no loose service files", () => {
    // This test is the exception, since it is about the directory itself.
    const loose = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name !== "layout.test.ts");

    expect(loose).toEqual([]);
  });

  it("has only the groups it declares", () => {
    const found = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    // A new directory here is a new category of service, which is worth
    // choosing on purpose rather than discovering in a diff.
    expect(found).toEqual([...GROUPS].sort());
  });

  it("keeps every group populated", () => {
    for (const group of GROUPS) {
      const files = readdirSync(join(SERVICES, group));
      expect(files.length, `${group} is empty`).toBeGreaterThan(0);
    }
  });
});

describe("the main directory above it", () => {
  // The same failure mode one level up: this directory accumulated loose
  // provider and settings modules for a while before they were grouped, so it
  // gets the same rule as `services/` — a file here is a deliberate decision.
  it("holds nothing loose but the process-level modules", () => {
    const loose = readdirSync(join(SERVICES, ".."), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();

    expect(loose).toEqual([...MAIN_ROOT_FILES].sort());
  });
});
