/**
 * The verify loop through the real host, session and agent, against a fake
 * model and a real project whose `npm test` is a small script. What matters is
 * what reaches the model and the wire: how many follow-ups went out, whether
 * they sit inside the user's run, and what the user would see.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { Reply } from "@abacus-ai/test-support/fake-provider";
import { afterEach, describe, expect, it } from "vitest";

import { hasType, live, runInput, type Live } from "../agui/__tests__/live.js";
import type { AguiEvent } from "../agui/wire.js";

const SENTINEL = "Independent verification";

/** `npm test`'s output, shaped as Jest prints it. Fails on what `calc.js` got wrong. */
const RUNNER = `
const fs = require("node:fs");
fs.appendFileSync(process.env.SUITE_LOG ?? "suite.log", process.cwd() + "\\n");
const { add } = require("./calc.js");
const tests = { adds: () => add(1, 2) === 3 };
if (fs.existsSync("legacy-failure")) tests.legacy = () => false;
const failed = Object.keys(tests).filter((name) => !tests[name]());
for (const name of failed) console.log("FAIL run-tests.js\\n  ● " + name + "\\n");
console.log("Tests: " + failed.length + " failed, " + (Object.keys(tests).length - failed.length) + " passed, " + Object.keys(tests).length + " total");
process.exit(failed.length > 0 ? 1 : 0);
`;
const GOOD = "exports.add = (a, b) => a + b;\n";
const BROKEN = "exports.add = (a, b) => a - b;\n";

const project = (
  cwd: string,
  options: { legacyFailure?: boolean; testScript?: string } = {}
): void => {
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      scripts: { test: options.testScript ?? "node run-tests.js" },
    })
  );
  fs.writeFileSync(path.join(cwd, "run-tests.js"), RUNNER);
  fs.writeFileSync(path.join(cwd, "calc.js"), GOOD);
  if (options.legacyFailure === true)
    fs.writeFileSync(path.join(cwd, "legacy-failure"), "");
};

const write = (content: string): Reply => ({
  call: { name: "write", args: { path: "calc.js", content } },
});

let open: Live | null = null;
let cwd = "";

/** A host in `mode`, on a project, with `reply` as the model. */
async function start(
  reply: (index: number) => Reply | Promise<Reply>,
  options: Parameters<typeof project>[1] & {
    mode?: string;
    env?: Record<string, string>;
  } = {}
): Promise<Live> {
  open = await live({
    reply,
    mode: options.mode ?? "YOLO",
    isolated: true,
    ...(options.env != null ? { env: options.env } : {}),
    setup: (dir) => {
      cwd = dir;
      project(dir, options);
    },
  });

  return open;
}

afterEach(async () => {
  await open?.close();
  open = null;
});

/** Requests the loop's follow-up started: it is the newest thing the model read. */
const followUps = (l: Live): string[] =>
  l
    .calls()
    .map((call) => JSON.stringify(call.messages.at(-1)?.content ?? ""))
    .filter((content) => content.includes(SENTINEL));

/** Waits until the model has had no request and the suite no run for `quietMs`. */
async function quiet(l: Live, quietMs = 1_500): Promise<void> {
  const suiteRuns = (): number =>
    fs.existsSync(path.join(cwd, "suite.log"))
      ? fs.readFileSync(path.join(cwd, "suite.log"), "utf8").length
      : 0;
  let seen = [l.providerCalls(), suiteRuns()].join();
  let since = Date.now();

  while (Date.now() - since < quietMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const now = [l.providerCalls(), suiteRuns()].join();

    if (now !== seen) {
      seen = now;
      since = Date.now();
    }
  }
}

const finished = (l: Live, count = 1): Promise<void> =>
  l.waitFor(hasType("RUN_FINISHED", count), "the run to end", 25_000);

const appLines = (l: Live): string[] =>
  l
    .events()
    .filter(
      (event): event is Extract<AguiEvent, { type: "TEXT_MESSAGE_START" }> =>
        event.type === "TEXT_MESSAGE_START"
    )
    .flatMap((event) => {
      const kind = (
        event as {
          metadata?: {
            abacus?: { userText?: { operator?: { kind?: string } } };
          };
        }
      ).metadata?.abacus?.userText?.operator?.kind;

      return kind != null ? [kind] : [];
    });

const shownText = (l: Live): string =>
  l
    .events()
    .flatMap((event) =>
      event.type === "TEXT_MESSAGE_CONTENT" ? [event.delta] : []
    )
    .join("\n");

describe("the cap", () => {
  it("sends one follow-up however many times the model breaks the tests again", async () => {
    // Every run writes the broken file again: on its own that never ends.
    const l = await start((index) =>
      index % 2 === 0 && index < 12 ? write(BROKEN) : { say: `reply ${index}` }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    expect(followUps(l)).toHaveLength(1);
    expect(l.providerCalls()).toBe(4);
  });

  it("starts again with a new message from the user", async () => {
    // Each follow-up mends it, so the next message's break is that turn's own.
    const l = await start((index) =>
      index % 2 === 1
        ? { say: `reply ${index}` }
        : write(index % 4 === 0 ? BROKEN : GOOD)
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);
    l.send(runInput("r2", "change it again"));
    await finished(l, 2);
    await quiet(l);

    expect(followUps(l)).toHaveLength(2);
    expect(appLines(l)).toEqual(["test-repair", "test-repair"]);
  });
});

describe("whose failure it is", () => {
  it("leaves a test that was already failing alone", async () => {
    const l = await start(
      (index) =>
        index === 0
          ? {
              call: {
                name: "write",
                args: { path: "notes.txt", content: "x" },
              },
            }
          : { say: "done" },
      { legacyFailure: true }
    );

    l.send(runInput("r1", "add a note"));
    await finished(l);
    await quiet(l);

    expect(followUps(l)).toHaveLength(0);
    expect(appLines(l)).toEqual([]);
    expect(l.providerCalls()).toBe(2);
    // The baseline ran somewhere else: the tree holds only what the turn wrote.
    const runs = fs.readFileSync(path.join(cwd, "suite.log"), "utf8");
    expect(runs.trim().split("\n")).toHaveLength(1);
    expect(fs.readFileSync(path.join(cwd, "calc.js"), "utf8")).toBe(GOOD);
    expect(fs.existsSync(path.join(cwd, "notes.txt"))).toBe(true);
  });

  it("sends exactly one follow-up for a new failure, naming only it", async () => {
    const l = await start(
      (index) => (index === 0 ? write(BROKEN) : { say: `reply ${index}` }),
      { legacyFailure: true }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    const [prompt, ...others] = followUps(l);

    expect(others).toEqual([]);
    expect(prompt).toContain("run-tests.js › adds");
    expect(prompt).not.toContain("- run-tests.js › legacy");
    // The edit stands: the baseline never put the old file back here.
    expect(fs.readFileSync(path.join(cwd, "calc.js"), "utf8")).toBe(BROKEN);
  });

  it("sends nothing when the suite could not run at all", async () => {
    const l = await start(
      (index) => (index === 0 ? write(BROKEN) : { say: "done" }),
      {
        testScript:
          "node -e \"console.error('Error: Cannot find module vitest'); process.exit(1)\"",
      }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    expect(followUps(l)).toHaveLength(0);
    expect(appLines(l)).toEqual([]);
  });

  it("tells the user once when tests failed but no test can be named", async () => {
    const l = await start(
      (index) => (index === 0 || index === 2 ? write(BROKEN) : { say: "done" }),
      {
        testScript:
          "node -e \"console.log('Tests: 1 failed, 2 passed, 3 total'); process.exit(1)\"",
      }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);
    l.send(runInput("r2", "again"));
    await finished(l, 2);
    await quiet(l);

    expect(followUps(l)).toHaveLength(0);
    expect(appLines(l)).toEqual(["tests-left-alone"]);
  });
});

describe("what the user sees", () => {
  it("runs the follow-up inside their run, as the app's line and not as their words", async () => {
    const l = await start((index) =>
      index === 0
        ? write(BROKEN)
        : index === 1
          ? { say: "first reply" }
          : index === 2
            ? write(GOOD)
            : { say: "fixed it" }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    expect(appLines(l)).toEqual(["test-repair"]);
    expect(shownText(l)).toContain("fixed it");
    expect(shownText(l)).not.toContain(SENTINEL);
    // Nothing the follow-up did lands after the run closes: that is what kept
    // it out of the chat and the transcript.
    const order = l.events().map((event) => event.type);
    expect(order.filter((type) => type === "RUN_FINISHED")).toHaveLength(1);
    expect(order.at(-1)).not.toBe("TEXT_MESSAGE_CONTENT");
    const text = l
      .events()
      .findLastIndex((event) => event.type === "TEXT_MESSAGE_CONTENT");
    expect(text).toBeLessThan(
      l.events().findIndex((event) => event.type === "RUN_FINISHED")
    );
  });
});

describe("Stop", () => {
  it("while the tests run: kills them and sends nothing", async () => {
    const l = await start(
      (index) => (index === 0 ? write(BROKEN) : { say: "done" }),
      {
        testScript:
          "node -e \"require('fs').writeFileSync('started',''); setTimeout(() => { require('fs').writeFileSync('ran-out',''); console.log('FAIL a.test.js'); process.exit(1) }, 1500)\"",
      }
    );

    l.send(runInput("r1", "change add"));
    await l.waitFor(
      () => fs.existsSync(path.join(cwd, "started")),
      "the suite"
    );
    l.send({ type: "cancel", runId: "r1" });
    await finished(l);
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(followUps(l)).toHaveLength(0);
    expect(fs.existsSync(path.join(cwd, "ran-out"))).toBe(false);
  });

  it("during the follow-up: ends it, and no more requests go out", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const l = await start(async (index) => {
      if (index === 0) return write(BROKEN);
      if (index === 2) await held;

      return { say: `reply ${index}` };
    });

    l.send(runInput("r1", "change add"));
    await l.waitFor(() => l.providerCalls() >= 3, "the follow-up");
    l.send({ type: "cancel", runId: "r1" });
    await finished(l);
    release();
    await quiet(l);

    expect(l.providerCalls()).toBe(3);
  });
});

describe("where it does not run", () => {
  it.each([
    ["an ask-first mode", "DEFAULT", {}],
    ["plan mode", "PLAN", {}],
    ["a hosted session", "YOLO", { ABACUSAI_BOT_CLIENT_KIND: "web_host" }],
    ["a chat app's session", "YOLO", { ABACUSAI_BOT_VERIFY_RETRIES: "0" }],
  ])("%s", async (_name, mode, env) => {
    const l = await start(
      (index) => (index === 0 ? write(BROKEN) : { say: "done" }),
      { mode, env }
    );

    l.send(runInput("r1", "change add"));
    await l.waitFor(
      (events) =>
        hasType("RUN_FINISHED")(events) ||
        events.some(
          (event) =>
            event.type === "CUSTOM" && event.name === "permission.pending"
        ),
      "the run to end or ask"
    );
    await quiet(l, 500);

    expect(fs.existsSync(path.join(cwd, "suite.log"))).toBe(false);
    expect(followUps(l)).toHaveLength(0);
    // Ask-first modes are still parked on the write's approval.
    l.send({ type: "cancel" });
    await l.waitFor(
      (events) => hasType("RUN_FINISHED")(events),
      "the parked run to end"
    );
  });
});

describe("the limit on a follow-up", () => {
  /** A model that keeps working until told to close, or for good. */
  const relentless =
    (closes: boolean) =>
    (index: number): Reply => {
      if (index === 0) return write(BROKEN);
      if (index === 1) return { say: "first reply" };
      if (closes && index === 5) return { say: "I could not finish the fix." };

      return { call: { name: "bash", args: { command: `echo ${index}` } } };
    };

  it("closes it out and says so in the chat", async () => {
    const l = await start(relentless(true), {
      env: { ABACUSAI_BOT_VERIFY_CALLS: "3" },
    });

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    // The turn's two, the limit's three, and the closing message.
    expect(l.providerCalls()).toBe(6);
    expect(appLines(l)).toEqual(["test-repair", "test-repair-limit"]);
    expect(shownText(l)).toContain("I could not finish the fix.");
  });

  it("stops a model that will not close out", async () => {
    const l = await start(relentless(false), {
      env: { ABACUSAI_BOT_VERIFY_CALLS: "3" },
    });

    l.send(runInput("r1", "change add"));
    await l.waitFor(hasType("RUN_ERROR"), "the run to be stopped", 25_000);
    await quiet(l);

    // The turn's two, the limit's three, the close-out's few: never open-ended.
    expect(l.providerCalls()).toBeLessThanOrEqual(2 + 3 + 3);
    expect(appLines(l)).toEqual(["test-repair", "test-repair-limit"]);
  });

  it("does not let the follow-up discard other work", async () => {
    const l = await start((index) =>
      index === 0
        ? write(BROKEN)
        : index === 2
          ? { call: { name: "bash", args: { command: "git stash" } } }
          : { say: `reply ${index}` }
    );

    l.send(runInput("r1", "change add"));
    await finished(l);
    await quiet(l);

    const result = JSON.stringify(l.calls().at(-1)?.messages.at(-1));
    expect(result).toContain("Not while repairing tests");
  });
});
