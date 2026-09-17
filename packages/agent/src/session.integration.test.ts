/**
 * `AbacusBotSession`, driven directly against a loopback model.
 *
 * This class is the whole agent — both front ends are thin shells around it —
 * and it was the least-covered file in the package. The e2e suites reach it
 * through a subprocess, which is right for the front ends and clumsy for the
 * session's own behaviour: what a stop does to a pending approval, what a reset
 * does to the transcript, what happens on a model that cannot be resolved.
 * Those are in-process here, so they are fast and can assert on the event
 * stream rather than on printed text.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// A model call that goes quiet is given up on after this long; the real
// window is two minutes, which no test should sit through.
process.env.ABACUSAI_BOT_MODEL_STALL_MS = "700";

import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
} from "./protocol.js";
import { AbacusBotSession, OPENLLM_POOL_EXHAUSTED_MESSAGE } from "./session.js";

let provider: FakeProvider;
let home: string;

/** A session wired to the fake provider, with everything it emitted. */
class Harness {
  readonly events: DesktopEvent[] = [];
  readonly session: AbacusBotSession;
  readonly cwd: string;

  constructor(options: { mode?: string; hostServices?: boolean } = {}) {
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-session-"));
    this.session = new AbacusBotSession({
      cwd: this.cwd,
      ...(options.mode != null ? { mode: options.mode } : {}),
      ...(options.hostServices != null
        ? { hostServices: options.hostServices }
        : {}),
      emit: (event) => this.events.push(event),
    });
  }

  /** Agent events of one type, unwrapped from the `event` envelope. */
  agent<T extends AgentEvent["type"]>(
    type: T
  ): Array<Extract<AgentEvent, { type: T }>> {
    return this.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter(
        (event): event is Extract<AgentEvent, { type: T }> =>
          event.type === type
      );
  }

  get text(): string {
    return this.agent("text_delta")
      .map((event) => event.content)
      .join("");
  }

  get permissions(): Array<
    Extract<DesktopEvent, { type: "permission_needed" }>
  > {
    return this.events.filter(
      (event): event is Extract<DesktopEvent, { type: "permission_needed" }> =>
        event.type === "permission_needed"
    );
  }

  /** Wait until `check` holds, so a test never races the agent loop. */
  async until(check: () => boolean, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out; saw: ${this.events.map((event) => event.type).join(", ")}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  dispose(): void {
    this.session.dispose();
    fs.rmSync(this.cwd, { recursive: true, force: true });
  }
}

let harnesses: Harness[] = [];

/**
 * What the session wrote to its log. Routing and retry lines go there and
 * never to the chat, so the tests read them back from here.
 */
function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: unknown
  ) => {
    lines.push(String(chunk));
    return true;
  }) as never);

  return { lines, restore: () => spy.mockRestore() };
}

/** The notices the chat would draw. */
const chatNotices = (harness: Harness): string[] =>
  harness.agent("notification").map((event) => event.message);

function session(
  options: { mode?: string; hostServices?: boolean } = {}
): Harness {
  const harness = new Harness(options);

  harnesses.push(harness);

  return harness;
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-session-home-"));
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
});

/**
 * Wait until the provider has gone a whole interval without a new request.
 *
 * `dispose` returns before the requests a session already has in flight do —
 * an aborted turn in particular can still have one on the wire. Clearing the
 * call log while one is outstanding does not drop it: it lands in the *next*
 * test, where `firstCall` then describes the disposed session rather than the
 * one under test. That is how a `document` tool reached a test that runs with
 * no host attached, on the runners slow enough to lose the race.
 */
async function settled(quietMs = 50, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let seen = provider.calls.length;
  let quietSince = Date.now();

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));

    if (provider.calls.length !== seen) {
      seen = provider.calls.length;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      return;
    }
  }
}

afterEach(async () => {
  for (const harness of harnesses) harness.dispose();
  harnesses = [];
  await settled();
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
  // The router's cooldowns outlive the session that learned them — that is the
  // point of them (openllm-cooldowns.ts), and they are keyed on the home
  // directory every test in this file shares. So one test rate-limiting
  // `openrouter/big:free` moved the *next* test's pool order under it, and the suite
  // failed on whichever test ran second. Each test gets a pool with nothing
  // held against it.
  fs.rmSync(path.join(home, "openllm-cooldowns.json"), { force: true });
});

describe("starting", () => {
  it("reports the model and mode it actually adopted", async () => {
    const harness = session({ mode: "plan" });

    await harness.session.start();

    const ready = harness.events.find(
      (event): event is Extract<DesktopEvent, { type: "ready" }> =>
        event.type === "ready"
    );

    expect(ready?.model).toBe("fake/fake-1");
    expect(ready?.mode).toBe(AgentMode.PlanMode);
  });

  it("records the opening mode before anything can change it", async () => {
    const harness = session({ mode: "acceptedits" });

    await harness.session.start();

    expect(harness.agent("mode_changed").at(0)?.mode).toBe(
      AgentMode.AcceptEdits
    );
  });

  it("falls back to a configured model, and says which one", async () => {
    const harness = session();

    // A model nobody has heard of would otherwise start a session that dies on
    // the first token, so it falls back to one that runs — but never silently.
    // A turn answered by a model the user did not choose, with nothing said,
    // reads as their choice having been ignored. A warning, not an error: the
    // session works, it is just not the model that was asked for.
    const named = new AbacusBotSession({
      cwd: harness.cwd,
      model: "nosuchprovider/nosuchmodel",
      emit: (event) => harness.events.push(event),
    });

    await named.start();

    try {
      expect(harness.agent("error")).toEqual([]);
      expect(harness.events.some((event) => event.type === "ready")).toBe(true);
      const notice = harness.agent("notification").at(0);
      expect(notice?.severity).toBe("warning");
      expect(notice?.message).toContain("nosuchprovider/nosuchmodel");
      expect(notice?.message).toContain("is running fake/fake-1");
    } finally {
      named.dispose();
    }
  });
});

describe("a model call that goes silent", () => {
  it("is abandoned and asked once more on the same model", async () => {
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      { stall: { say: "Starting" } },
      { say: "finished after all" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(
      () => harness.agent("turn_complete").length > 0,
      10_000
    );

    expect(harness.text).toContain("finished after all");
    expect(harness.agent("error")).toHaveLength(0);
    expect(log.lines.join("")).toContain(
      "fake/fake-1 stopped answering after 0.7s — asking it again."
    );
    expect(chatNotices(harness).join("\n")).not.toMatch(/asking it again/);
    // Two calls: the one that stalled and the one that answered.
    expect(provider.calls).toHaveLength(2);
    log.restore();
  });

  it("ends the turn saying so when the second attempt is silent too", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ stall: {} }));
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("error").length > 0, 10_000);

    const failure = harness.agent("error").at(-1);
    expect(failure?.error?.message).toBe(
      "The model stopped answering (no output for 0.7s). Try again, or switch to a different model."
    );
    expect(failure?.error?.code).toBe("turn_failed");
    // The chat is idle again, not busy forever behind a withheld idle event.
    expect(harness.agent("status_changed").at(-1)?.status).toBe(
      AgentStatus.Idle
    );
    expect(provider.calls).toHaveLength(2);
  });

  it("leaves a running tool alone, however long it takes", async () => {
    // Tools have their own limits, and a sub-agent legitimately runs for
    // minutes; the watchdog only covers the model's own silence.
    const harness = session({ mode: "yolo" });

    provider.scriptSequence([
      {
        call: {
          name: "bash",
          args: { command: "sleep 1.5; echo slow-tool-done" },
        },
      },
      { say: "the tool finished" },
    ]);
    await harness.session.start();
    await harness.session.send("run it");
    await harness.until(
      () => harness.agent("turn_complete").length > 0,
      15_000
    );

    expect(harness.text).toContain("the tool finished");
    expect(harness.agent("error")).toHaveLength(0);
    expect(
      harness
        .agent("notification")
        .map((event) => event.message)
        .join("\n")
    ).not.toMatch(/stopped answering/);
  });
});

describe("a turn", () => {
  it("streams the reply, then completes and goes idle", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ say: "HELLO THERE" }));
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    expect(harness.text).toContain("HELLO THERE");
    expect(harness.agent("status_changed").at(-1)?.status).toBe(
      AgentStatus.Idle
    );
  });

  it("brackets a tool call with a start and a settled result", async () => {
    const harness = session({ mode: "yolo" });

    provider.scriptSequence([
      { call: { name: "ls", args: {} } },
      { say: "listed" },
    ]);
    await harness.session.start();
    await harness.session.send("look around");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    expect(harness.agent("tool_execution_start").at(0)?.tool.name).toBe("ls");
    expect(harness.agent("tool_execution_complete")).toHaveLength(1);
  });

  it("carries the arguments on the settled call, not just the start", async () => {
    const harness = session({ mode: "yolo" });

    provider.scriptSequence([
      { call: { name: "write", args: { path: "out.txt", content: "x" } } },
      { say: "written" },
    ]);
    await harness.session.start();
    await harness.session.send("write a file");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    // The desktop's artifact extractor reads the output path off the settled
    // call; with an empty args object it recorded nothing at all.
    expect(
      harness.agent("tool_execution_complete").at(0)?.tool.input
    ).toMatchObject({
      path: "out.txt",
    });
  });
});

describe("approvals", () => {
  it("suspends the call until the answer arrives", async () => {
    const harness = session();

    provider.scriptSequence([
      { call: { name: "write", args: { path: "gated.txt", content: "x" } } },
      { say: "done" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("write a file");

    await harness.until(() => harness.permissions.length > 0);
    // Genuinely blocking: nothing may have happened yet.
    expect(fs.existsSync(path.join(harness.cwd, "gated.txt"))).toBe(false);

    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "accept"
    );
    await turn;

    expect(fs.readFileSync(path.join(harness.cwd, "gated.txt"), "utf8")).toBe(
      "x"
    );
  });

  it("does not run the tool when the answer is no", async () => {
    const harness = session();

    provider.scriptSequence([
      { call: { name: "write", args: { path: "refused.txt", content: "x" } } },
      { say: "refused" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("write a file");

    await harness.until(() => harness.permissions.length > 0);
    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "reject"
    );
    await turn;

    expect(fs.existsSync(path.join(harness.cwd, "refused.txt"))).toBe(false);
  });

  it("remembers an always-allow for the command it was given and no other", async () => {
    const harness = session();

    provider.script((_call, index) => {
      if (index === 0)
        return { call: { name: "bash", args: { command: "echo first" } } };
      if (index === 1)
        return { call: { name: "bash", args: { command: "echo second" } } };

      return { say: "done" };
    });
    await harness.session.start();

    const turn = harness.session.send("run some commands");

    await harness.until(() => harness.permissions.length > 0);
    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "allowAlways"
    );
    await turn;

    // `echo` was approved, so the second `echo` must not ask again.
    expect(harness.permissions).toHaveLength(1);
  });

  /**
   * The whole chain, not just its first word. Almost every command the agent
   * writes is `cd somewhere && do something`, and remembering only `cd` left
   * the half that does the work asking again on the very next call — so
   * "always" looked like a button that did nothing.
   */
  it("remembers every part of a chain it was told to always allow", async () => {
    const harness = session();

    provider.script((_call, index) => {
      if (index === 0)
        return {
          call: { name: "bash", args: { command: "cd . && echo first" } },
        };
      if (index === 1)
        return {
          call: { name: "bash", args: { command: "cd . && echo second" } },
        };

      return { say: "done" };
    });
    await harness.session.start();

    const turn = harness.session.send("run some commands");

    await harness.until(() => harness.permissions.length > 0);
    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "allowAlways"
    );
    await turn;

    expect(harness.permissions).toHaveLength(1);
  });

  it("clears the card when a pending approval is dropped", async () => {
    const harness = session();

    provider.scriptSequence([
      { call: { name: "write", args: { path: "x.txt", content: "x" } } },
      { say: "stopped" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("write a file");

    await harness.until(() => harness.permissions.length > 0);
    await harness.session.stop();
    await turn;

    // A card left on screen after the request behind it is gone is a button
    // that does nothing.
    expect(harness.agent("permission_cleared")).toHaveLength(1);
  });
});

describe("plan mode", () => {
  it("refuses a mutation instead of asking about it", async () => {
    const harness = session({ mode: "plan" });

    provider.scriptSequence([
      { call: { name: "write", args: { path: "nope.txt", content: "x" } } },
      { say: "refused" },
    ]);
    await harness.session.start();
    await harness.session.send("write a file");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    expect(harness.permissions).toHaveLength(0);
    expect(fs.existsSync(path.join(harness.cwd, "nope.txt"))).toBe(false);
  });

  it("refuses a sub-agent, which used to be the way around it", async () => {
    const harness = session({ mode: "plan" });

    provider.scriptSequence([
      {
        call: {
          name: "delegate_task",
          args: { task: "write a file called ESCAPED.txt" },
        },
      },
      { say: "refused" },
    ]);
    await harness.session.start();
    await harness.session.send("delegate a write");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    expect(fs.readdirSync(harness.cwd)).toHaveLength(0);
  });

  it("leaves plan mode when the user approves the plan, and says so", async () => {
    const harness = session({ mode: "plan" });

    provider.scriptSequence([
      { call: { name: "exit_plan_mode", args: { plan: "do the thing" } } },
      { say: "starting" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("plan it");

    await harness.until(() => harness.permissions.length > 0);
    expect(harness.permissions[0]!.request.type).toBe("exit_plan_mode");

    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "accept"
    );
    await turn;

    expect(harness.agent("mode_changed").at(-1)?.mode).toBe(AgentMode.Normal);
  });

  it("stays in plan mode when the user is not ready", async () => {
    const harness = session({ mode: "plan" });

    provider.scriptSequence([
      { call: { name: "exit_plan_mode", args: { plan: "do the thing" } } },
      { say: "still planning" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("plan it");

    await harness.until(() => harness.permissions.length > 0);
    harness.session.respondPermission(
      harness.permissions[0]!.permissionId,
      "reject"
    );
    await turn;

    expect(harness.agent("mode_changed").at(-1)?.mode).toBe(AgentMode.PlanMode);
  });
});

describe("changing the mode", () => {
  it("applies a mode it recognises", async () => {
    const harness = session();

    await harness.session.start();
    harness.session.setMode("yolo");

    expect(harness.agent("mode_changed").at(-1)?.mode).toBe(AgentMode.Yolo);
  });

  it("warns and stays put on one it does not", async () => {
    const harness = session({ mode: "plan" });

    await harness.session.start();
    harness.session.setMode("planing");

    expect(harness.agent("notification").at(-1)?.message).toContain(
      "not a mode"
    );
    expect(harness.agent("mode_changed").at(-1)?.mode).toBe(AgentMode.PlanMode);
  });
});

describe("changing the model", () => {
  it("reports the change when the reference resolves", async () => {
    const harness = session();

    await harness.session.start();
    await harness.session.setModel("fake/fake-1");

    expect(harness.agent("model_changed").at(-1)?.model).toBe("fake/fake-1");
  });

  it("reports an error and keeps the current model when it does not", async () => {
    const harness = session();

    await harness.session.start();
    await harness.session.setModel("nosuchprovider/nosuchmodel");

    expect(harness.agent("error").at(-1)?.error.code).toBe("model_unavailable");
    expect(harness.agent("model_changed")).toHaveLength(0);
  });

  it("keeps one unusable custom provider from hiding every other one", async () => {
    // pi validates a provider as it is registered, and an entry with no
    // `baseUrl` throws. The registration loop used to let that out, so every
    // provider after it — the custom entry the desktop had just written, for
    // one — was never registered, and the pick that needed it could not
    // resolve.
    const harness = session();

    await harness.session.start();

    const configFile = path.join(home, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      customProviders: unknown[];
    };

    config.customProviders.push(
      { id: "broken", apiKey: "test-key", models: [{ id: "broken-1" }] },
      {
        id: "behind-the-broken-one",
        baseUrl: provider.baseUrl,
        apiKey: "test-key",
        models: [{ id: "good-1", contextWindow: 131072 }],
      }
    );

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");

    try {
      await harness.session.setModel("behind-the-broken-one/good-1");

      expect(harness.agent("error")).toHaveLength(0);
      expect(harness.agent("model_changed").at(-1)?.model).toBe(
        "behind-the-broken-one/good-1"
      );
    } finally {
      // The home directory is shared by every test in this file.
      fs.writeFileSync(configFile, fakeProviderConfig(provider), "utf8");
    }
  });

  it("reports a failed switch as a refusal, not as an uncoded error", async () => {
    // The desktop keys on `model_unavailable` to release the pick the picker
    // is holding. A throw that reached the host's catch-all instead was
    // reported with no code at all: the picker held that pick for ever and
    // stopped switching models.
    const harness = session();

    await harness.session.start();

    const failing = harness.session as unknown as {
      applyModel: () => Promise<void>;
    };
    failing.applyModel = () =>
      Promise.reject(new Error("registration blew up"));

    await harness.session.setModel("fake/fake-1");

    const error = harness.agent("error").at(-1)?.error;
    expect(error?.code).toBe("model_unavailable");
    expect(error?.message).toContain("registration blew up");
  });

  it("picks up a provider registered in config.json after startup", async () => {
    const harness = session();

    await harness.session.start();

    // The custom-provider setup flow writes a customProviders entry while this
    // process is already running, and the desktop picker offers its models right away.
    // The registrations are a snapshot from start(), so without a refresh the
    // pick fails as "unknown model" until the app is reopened.
    const configFile = path.join(home, "config.json");
    const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as {
      customProviders: unknown[];
    };

    config.customProviders.push({
      id: "late",
      baseUrl: provider.baseUrl,
      apiKey: "test-key",
      models: [{ id: "late-1", contextWindow: 131072 }],
    });

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");

    try {
      await harness.session.setModel("late/late-1");

      expect(harness.agent("error")).toHaveLength(0);
      expect(harness.agent("model_changed").at(-1)?.model).toBe("late/late-1");
    } finally {
      // The home directory is shared by every test in this file.
      fs.writeFileSync(configFile, fakeProviderConfig(provider), "utf8");
    }
  });
});

describe("resetting the conversation", () => {
  it("clears the transcript rather than only aborting the turn", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ say: "first answer" }));
    await harness.session.start();
    await harness.session.send("remember the number 41");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    await harness.session.resetConversation();
    provider.calls.length = 0;

    await harness.session.send("what number");
    await harness.until(() => provider.calls.length > 0);

    // Aborting alone leaves pi's transcript intact, so every old message would
    // still be sent — and billed — with the next prompt.
    const sent = JSON.stringify(provider.firstCall?.messages ?? []);

    expect(sent).not.toContain("remember the number 41");
  });

  it("announces the fresh session, which the desktop keys the conversation on", async () => {
    const harness = session({ mode: "yolo" });

    await harness.session.start();

    const before = harness.events.filter(
      (event) => event.type === "ready"
    ).length;

    await harness.session.resetConversation();

    expect(
      harness.events.filter((event) => event.type === "ready").length
    ).toBe(before + 1);
    expect(harness.agent("segments_cleared")).toHaveLength(1);
  });
});

describe("stopping", () => {
  it("does not report an error for a turn the user stopped", async () => {
    const harness = session({ mode: "yolo" });

    provider.scriptSequence([
      { call: { name: "ls", args: {} } },
      { say: "done" },
    ]);
    await harness.session.start();

    const turn = harness.session.send("look around");

    await harness.until(() => harness.agent("status_changed").length > 0);
    await harness.session.stop();
    await turn;

    // Reporting an abort the user asked for paints an error in the transcript
    // for doing exactly what they said.
    expect(harness.agent("error")).toHaveLength(0);
  });
});

describe("without a host attached", () => {
  it("registers neither the components nor their prompt", async () => {
    const harness = session({ mode: "yolo", hostServices: false });

    await harness.session.start();
    await harness.session.send("hello");
    await harness.until(() => provider.calls.length > 0);

    const tools = provider.firstCall?.tools ?? [];

    expect(tools).not.toContain("document");
    expect(tools).not.toContain("ppt");
    expect(tools).not.toContain("design");
  });

  it("still registers the tools that need nothing but this process", async () => {
    const harness = session({ mode: "yolo", hostServices: false });

    await harness.session.start();
    await harness.session.send("hello");
    await harness.until(() => provider.calls.length > 0);

    const tools = provider.firstCall?.tools ?? [];

    expect(tools).toEqual(
      expect.arrayContaining([
        "read",
        "write",
        "edit",
        "bash",
        "grep",
        "find",
        "ls",
      ])
    );
  });
});

/**
 * OpenLLM, end to end: the virtual id resolves to a real model from the free
 * pool, a provider failure moves the conversation to the next model instead of
 * ending it, and running out of pool surfaces the error instead of spinning.
 *
 * The pool here is an "openrouter" custom provider pointing at the loopback
 * fake, its models named `:free` so they count as the free tier — a custom
 * provider is the one kind a test can conjure without the network. pi's own retry loop is disabled for these:
 * it would otherwise re-send the same failing call with exponential backoff
 * before the rotation gets its turn, which tests the backoff and not the
 * router.
 */
describe("OpenLLM", () => {
  const openLlmConfig = (): string =>
    JSON.stringify({
      defaultModel: "openllm/auto",
      customProviders: [
        {
          id: "openrouter",
          baseUrl: provider.baseUrl,
          apiKey: "test-key",
          models: [
            { id: "big:free", contextWindow: 131072 },
            { id: "small:free", contextWindow: 65536 },
          ],
        },
      ],
    });

  const settingsPath = (): string => path.join(home, "agent", "settings.json");

  beforeAll(() => {
    fs.mkdirSync(path.join(home, "agent"), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        retry: { enabled: false, provider: { maxRetries: 0 } },
      }),
      "utf8"
    );
    fs.writeFileSync(path.join(home, "config.json"), openLlmConfig(), "utf8");
  });

  afterAll(() => {
    fs.rmSync(settingsPath(), { force: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      fakeProviderConfig(provider),
      "utf8"
    );
  });

  it("starts on the best pool model but reports the router's id", async () => {
    const harness = session({ mode: "yolo" });

    await harness.session.start();

    const ready = harness.events.find(
      (event): event is Extract<DesktopEvent, { type: "ready" }> =>
        event.type === "ready"
    );

    // The router is the user's choice; the concrete model is an
    // implementation detail.
    expect(ready?.model).toBe("openllm/auto");

    // Starting a session is not routing a turn. The desktop starts one
    // whenever an old chat is reopened, so a line here landed at the end of a
    // conversation the user had only just opened — under an answer from last
    // week, with nothing sent.
    expect(
      harness
        .agent("notification")
        .map((event) => event.message)
        .join("\n")
    ).not.toMatch(/Routing to/);
  });

  it("never says which model the pool picked", async () => {
    // The user chose "openllm/auto" so they would not have to think about the
    // model. Naming the winner over every turn is a running commentary on an
    // implementation detail. Bots dropped these lines first; sessions have no
    // better claim on them.
    const harness = session({ mode: "yolo" });

    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    const messages = harness
      .agent("notification")
      .map((event) => event.message)
      .join("\n");

    expect(messages).not.toMatch(/Routing to/);
    expect(messages).not.toMatch(/Routed to/);
    // Withheld from the display only: the turn still ran on whatever the
    // router picked.
    expect(harness.agent("turn_complete").length).toBeGreaterThan(0);
  });

  it("keeps the routing narration out of a bot's chat too", async () => {
    process.env.ABACUSAI_BOT_PERSONA = "/nonexistent/persona.md";
    try {
      const harness = session({ mode: "yolo" });

      await harness.session.start();
      await harness.session.send("hi");
      await harness.until(() => harness.agent("turn_complete").length > 0);

      expect(
        harness
          .agent("notification")
          .map((event) => event.message)
          .join("\n")
      ).not.toMatch(/Routing to/);
    } finally {
      delete process.env.ABACUSAI_BOT_PERSONA;
    }
  });

  it("routes every turn, not just the first one in a session", async () => {
    // Reopening a chat and sending a message is a turn like any other, and it
    // is routed like any other — the line the startup notice used to write is
    // owed to the message, not to the session being opened.
    const harness = session({ mode: "yolo" });

    await harness.session.start();
    await harness.session.send("first");
    await harness.until(() => harness.agent("turn_complete").length > 0);
    await harness.session.send("second");
    await harness.until(() => harness.agent("turn_complete").length > 1);

    // Both turns ran and were routed; neither narrated it. The rotation state
    // is what this is really about — it must not collapse two turns into one
    // episode just because nothing is drawn any more.
    expect(harness.agent("turn_complete").length).toBe(2);
    expect(
      harness
        .agent("notification")
        .map((event) => event.message)
        .join("\n")
    ).not.toMatch(/Routing to/);
  });

  it("gives up on a model that goes silent and moves to the next", async () => {
    // A Windows user's first message: the pool's first model opened a stream
    // and never sent another byte. Nothing in the stack ended it before the
    // desktop's ten-minute watchdog, so her first turn was two minutes of
    // nothing and then an error. The stalled call is abandoned and the pool
    // moves on, the same as for a model that answered with a failure.
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      { stall: {} },
      { say: "answered by the next model" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(
      () => harness.agent("turn_complete").length > 0,
      10_000
    );

    expect(harness.text).toContain("answered by the next model");
    expect(harness.agent("error")).toHaveLength(0);
    // The rotation is logged, not shown: the chat carries the answer.
    expect(log.lines.join("")).toMatch(
      /failed \(no reply in 1s\) — routing to openrouter\/small:free/
    );
    expect(chatNotices(harness).join("\n")).not.toMatch(/routing to/);
    // Still the router in the picker: which model answered is its business.
    expect(harness.agent("model_changed").at(-1)?.model).toBe("openllm/auto");
    log.restore();
  });

  it("moves the turn to the next model when the provider fails", async () => {
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      { fail: { status: 429, message: "rate limited upstream" } },
      { say: "recovered on the second model" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    // The reply came from the fallback model, in the same turn, with no
    // terminal error painted over it.
    expect(harness.text).toContain("recovered on the second model");
    expect(harness.agent("error")).toHaveLength(0);
    expect(log.lines.join("")).toMatch(/routing to openrouter\/small:free/);
    expect(chatNotices(harness).join("\n")).not.toMatch(/routing to/);
    // The picker keeps highlighting the router, not the model of the day.
    expect(harness.agent("model_changed").at(-1)?.model).toBe("openllm/auto");
    log.restore();
  });

  it("keeps the whole routing episode out of the chat", async () => {
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      { fail: { status: 429, message: "rate limited upstream" } },
      { say: "recovered on the second model" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    // Opening, failure and settling are all the router's business.
    expect(
      harness.agent("notification").filter((e) => e.notificationKey != null)
    ).toEqual([]);
    expect(log.lines.join("")).toContain(
      "openrouter/big:free failed (429) — routing to openrouter/small:free…"
    );
    log.restore();
  });

  it("says the code, not the provider's paragraph about it", async () => {
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      {
        fail: {
          status: 429,
          message:
            "temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
        },
      },
      { say: "recovered on the second model" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    const failure = log.lines.find((line) => line.includes("failed"));

    expect(failure).toContain(
      "openrouter/big:free failed (429) — routing to openrouter/small:free…"
    );
    expect(failure).not.toMatch(/openrouter\.ai|retry shortly/);
    log.restore();
  });

  it("surfaces the failure once the whole pool is exhausted", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({
      fail: { status: 429, message: "rate limited upstream" },
    }));
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("error").length > 0);

    // A pool that is down is reported, not spun on forever: the turn ends,
    // and the error names what the provider said.
    expect(harness.agent("turn_complete").length).toBeGreaterThan(0);

    const reported = harness.agent("error").at(0)?.error;

    // One fixed line and the switch card: under the router the user never
    // chose a model, so no provider's sentence about one is shown, and the
    // way out is a button rather than a red line.
    expect(reported?.message).toBe(OPENLLM_POOL_EXHAUSTED_MESSAGE);
    expect(reported?.message).not.toMatch(/429|upstream|https?:\/\//);
    expect(reported?.detail).toBeUndefined();
    expect(reported?.actions).toEqual([{ type: "switch-model" }]);
  });

  it("deactivates on a concrete pick and reactivates on the router id", async () => {
    const harness = session({ mode: "yolo" });

    await harness.session.start();
    await harness.session.setModel("openrouter/small:free");

    // Picking a real model leaves the router: the session reports the model
    // itself again.
    expect(harness.agent("model_changed").at(-1)?.model).toBe(
      "openrouter/small:free"
    );

    await harness.session.setModel("openllm/auto");

    expect(harness.agent("model_changed").at(-1)?.model).toBe("openllm/auto");
  });

  /**
   * The retry budget, with pi's retry loop LIVE this time.
   *
   * The tests above disable it to isolate the rotation; these two pin how the
   * two loops share a failure. On OpenLLM, one same-model retry is the whole
   * budget — the pool's answer to a failing provider is a different model,
   * and the second and third retries were half a minute of backoff against a
   * model that stays rate-limited for the next five. On a concrete model the
   * full configured budget stands: with no fallback, retries are the only
   * recovery there is. baseDelayMs is 1 so the backoff costs the test
   * nothing.
   */
  describe("the retry budget", () => {
    const retrySettings = (maxRetries: number): string =>
      JSON.stringify({
        retry: { enabled: true, maxRetries, baseDelayMs: 1 },
      });

    const retriesDisabled = JSON.stringify({
      retry: { enabled: false, provider: { maxRetries: 0 } },
    });

    afterEach(() => {
      // The sibling tests assume the describe-level settings (retries off);
      // put them back however these tests end.
      fs.writeFileSync(settingsPath(), retriesDisabled, "utf8");
    });

    it("spends one retry on the failing model, then rotates", async () => {
      fs.writeFileSync(settingsPath(), retrySettings(3), "utf8");

      const harness = session({ mode: "yolo" });

      provider.scriptSequence([
        { fail: { status: 429, message: "rate limited upstream" } },
        { fail: { status: 429, message: "rate limited upstream" } },
        { say: "recovered after one retry" },
      ]);
      await harness.session.start();
      await harness.session.send("hi");
      await harness.until(() => harness.agent("turn_complete").length > 0);

      // One retry (1/1), not the configured three: attempts two and three
      // would only have delayed the model switch that actually answered.
      expect(harness.agent("retry")).toHaveLength(1);
      expect(harness.agent("retry").at(0)?.maxAttempts).toBe(1);
      expect(harness.text).toContain("recovered after one retry");
      expect(harness.agent("error")).toHaveLength(0);
    });

    it("keeps the full budget on a concrete model, which has no fallback", async () => {
      fs.writeFileSync(settingsPath(), retrySettings(2), "utf8");

      const harness = session({ mode: "yolo" });

      provider.script(() => ({
        fail: { status: 429, message: "rate limited upstream" },
      }));
      await harness.session.start();
      await harness.session.setModel("openrouter/small:free");
      await harness.session.send("hi");
      await harness.until(() => harness.agent("error").length > 0);

      // Both configured retries run: leaving the router hands the budget
      // back, and the cap must not leak into sessions that never pooled.
      expect(harness.agent("retry")).toHaveLength(2);
      expect(harness.agent("retry").at(0)?.maxAttempts).toBe(2);
    });
  });
});

describe("a provider failure the turn recovered from", () => {
  it("is logged in a line, not the provider's paragraph, and never shown", async () => {
    const harness = session({ mode: "yolo" });
    const log = captureLog();

    provider.scriptSequence([
      {
        fail: {
          status: 429,
          message:
            "temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations",
        },
      },
      { say: "recovered on the retry" },
    ]);
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    const retries = log.lines.filter((line) => line.includes("retrying"));

    expect(retries.at(0)).toContain(
      "The model provider is rate-limited — retrying (attempt 2)."
    );
    expect(retries.join("\n")).not.toMatch(
      /openrouter\.ai|429|add your own key/
    );
    // The chat sees the recovered turn, not the retry.
    expect(chatNotices(harness).join("\n")).not.toMatch(/retrying/);
    log.restore();
  });
});

/**
 * A turn that outgrew the model's context is recoverable, and the recovery is
 * not a different model.
 *
 * pi compacts when the last turn's reported usage crosses the window, which
 * misses the case that actually bit: a single message carrying several file
 * attachments jumps the fence in one step, on a window we only guessed at.
 */
describe("a turn the provider says is too long", () => {
  // Without this, pi's own retry loop answers the scripted failure before the
  // turn ends, and the recovery under test never runs. See the OpenLLM suite.
  const settingsPath = (): string => path.join(home, "agent", "settings.json");

  beforeAll(() => {
    fs.mkdirSync(path.join(home, "agent"), { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({
        retry: { enabled: false, provider: { maxRetries: 0 } },
      }),
      "utf8"
    );
  });

  afterAll(() => {
    fs.rmSync(settingsPath(), { force: true });
  });

  const TOO_LONG =
    "The input is longer than the model's context length trace_id: bbb02d9cb0970aefb184fe19150370ce";

  it("summarizes the history and runs the turn again", async () => {
    const harness = session({ mode: "yolo" });
    // Compaction only has something to do once there is history older than the
    // recency window it keeps (20k tokens), so the first turn has to be a real
    // one. Roughly 60k tokens of it, at the four-characters-a-token estimate.
    const bulky = "the transcript so far, at length. ".repeat(7_000);

    provider.scriptSequence([
      { say: bulky },
      { fail: { status: 400, message: TOO_LONG } },
      { say: "a summary of the conversation so far" },
      { say: "answered after compacting" },
    ]);
    await harness.session.start();
    await harness.session.send("read these files");
    await harness.until(() => harness.agent("turn_complete").length > 0);
    await harness.session.send("now explain them");
    await harness.until(() => harness.agent("turn_complete").length > 1);

    // The compacted turn is observable in what the provider was sent, not in
    // anything the user was told: the continuation prompt rides along as user
    // text on the retried call.
    expect(
      provider.calls.some((call) =>
        call.userText.some((text) => text.includes("summarized to fit"))
      )
    ).toBe(true);
    expect(harness.agent("error")).toEqual([]);
    expect(harness.text).toContain("answered after compacting");
  });

  it("says so rather than hanging when there is nothing left to summarize", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ fail: { status: 400, message: TOO_LONG } }));
    await harness.session.start();
    await harness.session.send("explain these 4");
    await harness.until(() => harness.agent("error").length > 0);

    // A one-message history has nothing older than the recency window, so the
    // summary cannot be written. The turn ends on what the user can act on,
    // and says nothing about the machinery that tried.
    const reported = harness.agent("error").at(0)?.error.message ?? "";

    expect(reported).toContain("This conversation is too long for the model");
    expect(reported).not.toMatch(/summar|compact/i);
    expect(harness.agent("turn_complete").length).toBeGreaterThan(0);
  });

  it("says what happened in a sentence, not the provider's trace id", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ fail: { status: 400, message: TOO_LONG } }));
    await harness.session.start();
    await harness.session.send("explain these 4");
    await harness.until(() => harness.agent("error").length > 0);

    const reported = harness.agent("error").at(0)?.error.message ?? "";

    expect(reported).toContain("This conversation is too long for the model");
    expect(reported).not.toMatch(/trace_id/);
  });

  it("compacts once, then stops rather than looping on summaries", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({ fail: { status: 400, message: TOO_LONG } }));
    await harness.session.start();
    await harness.session.send("explain these 4");
    await harness.until(() => harness.agent("turn_complete").length > 0);

    const retries = provider.calls.filter((call) =>
      call.userText.some((text) => text.includes("summarized to fit"))
    );

    expect(retries.length).toBeLessThanOrEqual(1);
  });

  it("tells the user nothing about the compaction it just did", async () => {
    const harness = session({ mode: "yolo" });
    const bulky = "the transcript so far, at length. ".repeat(7_000);

    provider.scriptSequence([
      { say: bulky },
      { fail: { status: 400, message: TOO_LONG } },
      { say: "a summary of the conversation so far" },
      { say: "answered after compacting" },
    ]);
    await harness.session.start();
    await harness.session.send("read these files");
    await harness.until(() => harness.agent("turn_complete").length > 0);
    await harness.session.send("now explain them");
    await harness.until(() => harness.agent("turn_complete").length > 1);

    // Housekeeping the agent does to keep answering is not news: the user
    // asked a question and gets an answer, with nothing in between about a
    // limit they did not cause and cannot act on.
    expect(
      harness
        .agent("notification")
        .map((event) => event.message)
        .filter((message) => /summar|compact|context|too long/i.test(message))
    ).toEqual([]);
    expect(harness.agent("error")).toEqual([]);
  });
});

describe("a model that cannot do what was asked of it", () => {
  it("names the limitation rather than the provider's model suggestions", async () => {
    const harness = session({ mode: "yolo" });

    provider.script(() => ({
      fail: {
        status: 400,
        message:
          "This LLM does not support tool calling. Please use a different LLM that supports tools (e.g. gpt-5.1, claude-4.5-sonnet).",
      },
    }));
    await harness.session.start();
    await harness.session.send("hi");
    await harness.until(() => harness.agent("error").length > 0);

    const reported = harness.agent("error").at(0)?.error.message ?? "";

    expect(reported).toContain("This model can't use tools");
    expect(reported).toContain("Switch to a model that supports tool calling.");
  });
});
