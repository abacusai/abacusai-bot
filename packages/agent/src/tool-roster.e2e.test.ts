/**
 * Every tool the agent registers must have an off switch and a pinned
 * permission decision.
 *
 * Both checks are against the real roster the NDJSON host builds, because a
 * tool nobody thought about is ungated and unswitchable by default — which is
 * how `background` shipped able to run a shell command in plan mode.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TOOL_NAME_ALIASES } from "./excluded-tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
/** The NDJSON host the desktop spawns, built. */
const HOST = path.join(REPO_ROOT, "packages", "agent", "dist", "main.js");

/**
 * Tools that are deliberately not switchable, so their absence from the
 * Capabilities registry is correct.
 *
 * `exit_plan_mode` is a mode's only exit, and must not depend on which toolsets
 * are on. `current_time` is a clock, not a capability.
 */
const NOT_SWITCHABLE = ["exit_plan_mode", "current_time"];

/** The table every tool's permission decision is pinned in. */
const GATE_ROSTER = path.join(
  REPO_ROOT,
  "packages",
  "agent",
  "src",
  "gate-roster.test.ts"
);

/** The registry the Capabilities pane and the exclude list are both built from. */
const TOOLSETS = path.join(
  REPO_ROOT,
  "apps",
  "desktop",
  "src",
  "shared",
  "toolsets.ts"
);

let provider: FakeProvider;
let home: string;
let cwd: string;

/** Run the NDJSON host for one turn and return the roster it built. */
async function hostTools(): Promise<string[]> {
  provider.calls.length = 0;

  await new Promise<void>((resolve) => {
    const child = spawn(process.execPath, [HOST, "--permission-mode", "YOLO"], {
      cwd,
      env: {
        ...process.env,
        ABACUSAI_BOT_HOME: home,
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let seen = "";
    // The host is asked to stop, and the promise settles on its exit — not
    // on the ask. Settling early let afterAll remove the temp dirs while the
    // host was still writing its agent state into one and holding the other
    // open: ENOTEMPTY on Linux, EBUSY on Windows.
    const done = (): void => {
      child.stdin.end();
      child.kill();
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    const timer = setTimeout(done, 25_000);

    child.stdout.on("data", (chunk) => {
      seen += String(chunk);

      if (seen.includes("turn_complete")) {
        clearTimeout(timer);
        done();
      }
    });
    child.stderr.on("data", () => undefined);
    child.stdin.write(
      `${JSON.stringify({ type: "send", message: "hello" })}\n`
    );
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return [...(provider.calls[0]?.tools ?? [])].sort();
}

beforeAll(async () => {
  // No pi.dev catalog fetch: the roster is not about models, and the fetch
  // lands its store file in the temp home while it is being torn down.
  process.env.PI_OFFLINE = "1";
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-roster-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-roster-ws-"));
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
}, 180_000);

afterAll(async () => {
  await provider?.close();
  // pi's catalog refresh writes into the agent dir after the session is
  // gone; a plain rm raced it into ENOTEMPTY on CI.
  const rm = { recursive: true, force: true, maxRetries: 10, retryDelay: 300 };
  // A temp dir a straggler still holds is not worth failing the suite for.
  for (const dir of [home, cwd]) {
    try {
      fs.rmSync(dir, rm);
    } catch {
      // Left for the OS to clean up.
    }
  }
});

describe("the tools the agent registers", () => {
  it("are all switchable from the Capabilities pane", async () => {
    // The pane is built from `TOOLSETS`, and so is the exclude list the agent
    // is spawned with — so a tool missing from it is a tool with no off
    // switch. `background` was exactly that: switching Terminal off left it
    // registered, so the toggle read "no shell" and meant "no `bash`".
    const declared = fs.readFileSync(TOOLSETS, "utf8");
    const registered = await hostTools();

    // Through the same alias the exclude list uses: the registry says `glob`
    // where pi says `find`, and both halves already agree on that.
    const unswitchable = registered
      .map((tool) => TOOL_NAME_ALIASES[tool] ?? tool)
      .filter(
        (tool) =>
          !NOT_SWITCHABLE.includes(tool) &&
          !new RegExp(`['"]${tool}['"]`).test(declared)
      );

    expect(unswitchable).toEqual([]);
  }, 120_000);

  it("all have a pinned permission decision", async () => {
    const roster = fs.readFileSync(GATE_ROSTER, "utf8");
    const registered = await hostTools();

    const unpinned = registered.filter(
      (tool) =>
        !NOT_SWITCHABLE.includes(tool) &&
        !new RegExp(`name: ['"]${tool}['"]`).test(roster)
    );

    expect(unpinned).toEqual([]);
  }, 120_000);

  it("include the ones that need nothing but this process", async () => {
    // Each of these has been missing from a front end at some point, by
    // accident: they arrive over MCP, and a roster built without one is a
    // roster silently short a tool.
    expect(await hostTools()).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
        "todo",
        "delegate_task",
      ])
    );
  }, 120_000);
});
