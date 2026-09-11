import { fakePi, type FakeTool } from "@abacus-ai/test-support/fake-pi";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
/**
 * The point of backgrounding is that the process is still there afterwards.
 *
 * So these spawn real ones. A mocked child_process would happily report a
 * server as "running" in exactly the case this exists to catch — the command
 * that prints "Serving…" and then dies.
 *
 * There is one way in: `bash` with `background: true`. `fetch_background_output`
 * and `kill_process` are how the agent looks at what that started and stops it.
 * A second tool used to offer the same four actions under its own name; it was
 * redundant, and it was also a way to run a shell command the gate never saw.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withBackgroundOption } from "../background-bash.js";
import {
  listBackgroundJobs,
  resetBackgroundJobs,
} from "../background-processes.js";
import { default as backgroundExtension } from "./background.js";

/** The two tools the extension registers, from one loaded instance. */
function tools(): { fetch: FakeTool; kill: FakeTool } {
  const pi = fakePi();

  backgroundExtension(pi.api as never);

  const fetch = pi.tools.get("fetch_background_output");
  const kill = pi.tools.get("kill_process");

  if (fetch == null || kill == null) {
    throw new Error(
      `registered ${[...pi.tools.keys()].join(", ") || "nothing"}`
    );
  }

  return { fetch, kill };
}

/**
 * `bash` with the background option, over a local shell.
 *
 * Wrapping a stand-in definition rather than pi's own keeps this about the
 * background branch, which is the only part `withBackgroundOption` owns.
 */
function backgroundBash(cwd = process.cwd()): FakeTool {
  const inner = {
    name: "bash",
    label: "Bash",
    description: "run a command",
    parameters: { properties: {} },
    execute: async () => ({
      content: [{ type: "text" as const, text: "foreground" }],
      details: {},
    }),
  };

  return withBackgroundOption(
    inner as never,
    cwd,
    createLocalBashOperations()
  ) as unknown as FakeTool;
}

const run = async (
  tool: FakeTool,
  params: Record<string, unknown>
): Promise<string> => {
  const result = await tool.execute("call-1", params);

  return result.content.map((block) => block.text).join("\n");
};

const start = (command: string): Promise<string> =>
  run(backgroundBash(), { command, background: true });

// The processes are tracked per process, not per extension instance — one agent
// has one set of children however many tools reach them, and that is what makes
// cleanup and `kill_process` cover everything. So a test has to clear them, or
// it inherits the previous one's servers and its ids start at bg-7.
beforeEach(() => {
  resetBackgroundJobs();
});

afterEach(() => {
  resetBackgroundJobs();
});

describe("a command that stays up", () => {
  it("is still running when the call returns", async () => {
    // Prints, then sleeps — the shape of every dev server.
    const out = await start("echo listening on 8080; sleep 30");

    expect(out).toContain("bg-1");
    expect(listBackgroundJobs()).toHaveLength(1);
  });

  it("can be read back later", async () => {
    await start("echo ready; sleep 30");

    expect(await run(tools().fetch, { id: "bg-1" })).toContain("ready");
  });

  it("is listed when no id is given", async () => {
    await start("sleep 30");

    expect(await run(tools().fetch, {})).toContain("bg-1");
  });

  it("stops when asked, and says so when it is already gone", async () => {
    await start("sleep 30");

    const { kill } = tools();

    expect(await run(kill, { id: "bg-1" })).toContain("Stopped");
    expect(await run(kill, { id: "bg-1" })).toContain("nothing to stop");
  });

  it("says so for an id it never issued", async () => {
    expect(await run(tools().kill, { id: "bg-99" })).toContain(
      "No background process"
    );
  });

  it("stops everything when no id is given", async () => {
    await start("sleep 30");
    await start("sleep 30");

    expect(await run(tools().kill, {})).toContain("2 processes");
  });
});

/**
 * Read a job back once the shell it spawned has actually gone.
 *
 * These tests spawn a real process, so how long bash takes to run, exit and be
 * reaped is the machine's business, not theirs. A fixed wait made it theirs:
 * on a loaded CI runner 400ms was not always enough, and the test failed on a
 * process that was a moment from exiting rather than on one wrongly reported
 * as running — the thing it exists to catch. Polling asserts the same claim
 * without pinning it to a machine's speed.
 */
async function fetchOnceGone(id = "bg-1"): Promise<string> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const out = await run(tools().fetch, { id });

    if (out.includes("exited") || Date.now() >= deadline) return out;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("a command that dies", () => {
  it("is reported as finished rather than as a server that is there", async () => {
    // The real failure: live-server printed "Serving…" and exited 1.
    await start("echo Serving at http://127.0.0.1:8080; exit 1");

    const out = await fetchOnceGone();

    expect(out).toContain("exited");
    expect(out).not.toContain("running");
  }, 15_000);

  it("keeps what it managed to print", async () => {
    await start("echo Serving at http://127.0.0.1:8080; exit 1");

    expect(await fetchOnceGone()).toContain("Serving at");
  }, 15_000);
});

describe("bad input", () => {
  it("needs a command to start", async () => {
    expect(
      await run(backgroundBash(), { command: "  ", background: true })
    ).toContain("A command is required");
  });

  it("needs a known id to read", async () => {
    expect(await run(tools().fetch, { id: "bg-99" })).toContain(
      "No background process"
    );
  });

  it("says nothing is running when nothing is", async () => {
    expect(await run(tools().fetch, {})).toContain("Nothing has been started");
  });

  it("says nothing was running when asked to stop everything", async () => {
    expect(await run(tools().kill, {})).toContain("Nothing was running");
  });
});

describe("the process exit hook", () => {
  it("stays at one however many sessions load the extension", () => {
    // One `process.on("exit")` per session hit Node's ten-listener warning, and
    // there is no per-extension dispose to remove them on: `session_shutdown`
    // fires on reload only, not when a session is disposed.
    const before = process.listenerCount("exit");

    for (let index = 0; index < 12; index++) tools();

    expect(process.listenerCount("exit")).toBeLessThanOrEqual(before + 1);
  });
});

describe("reading one back", () => {
  it("says so when it printed nothing", async () => {
    await start("sleep 30");

    expect(await run(tools().fetch, { id: "bg-1" })).toContain(
      "(nothing printed yet)"
    );
  });
});
