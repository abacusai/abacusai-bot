/**
 * `delegate_task`, and the bounds on a run nobody is watching.
 *
 * The header of delegation.ts lists three deliberate limits, and one of them —
 * "a hard turn ceiling, so a confused sub-agent ends rather than running until
 * the budget does" — was not implemented: `turns` was counted, reported, and
 * never compared to anything. Nothing else could stop such a run, because the
 * tool-timeouts watchdog reports an overrun but cannot end a call. So these
 * tests drive a sub-agent into exactly that loop.
 */
import { getEventListeners } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import {
  ModelRegistry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { runDelegatedTask } from "./delegation.js";
import type { AgentEvent } from "./protocol.js";
import { createModelRuntime } from "./providers.js";

let provider: FakeProvider;
let home: string;
let agentDir: string;

/** Everything a delegated run needs, pointed at the fake provider. */
async function context(
  cwd: string
): Promise<Parameters<typeof runDelegatedTask>[0]> {
  const modelRuntime = await createModelRuntime(agentDir);
  const registry = new ModelRegistry(modelRuntime);

  registry.registerProvider("fake", {
    name: "fake",
    baseUrl: provider.baseUrl,
    apiKey: "test-key",
    api: "openai-completions" as const,
    models: [
      {
        id: "fake-1",
        name: "fake-1",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  });

  return {
    cwd,
    agentDir,
    modelRuntime,
    settingsManager: SettingsManager.create(cwd, agentDir),
    skillPaths: [],
    model: registry.getAvailable().find((model) => model.provider === "fake"),
  };
}

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-delegation-"));
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(
    path.join(os.tmpdir(), "abacusai-bot-delegation-home-")
  );
  agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
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

afterEach(() => {
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("a delegated run that finishes", () => {
  it("returns the sub-agent's last message as the answer", async () => {
    provider.script(() => ({ say: "THE SUB-AGENT ANSWER" }));

    const result = await runDelegatedTask(
      await context(workspace()),
      "find something out",
      () => undefined
    );

    expect(result.stoppedBy).toBe("completed");
    expect(result.text).toContain("THE SUB-AGENT ANSWER");
  });

  it("forwards the sub-agent's tool calls so its card shows the work", async () => {
    const events: AgentEvent[] = [];

    provider.scriptSequence([
      { call: { name: "ls", args: {} } },
      { say: "listed" },
    ]);

    await runDelegatedTask(await context(workspace()), "look around", (event) =>
      events.push(event)
    );

    expect(events.some((event) => event.type === "tool_execution_start")).toBe(
      true
    );
  });

  it("says so plainly when the sub-agent produced nothing", async () => {
    provider.script(() => ({ say: "" }));

    const result = await runDelegatedTask(
      await context(workspace()),
      "say nothing",
      () => undefined
    );

    expect(result.text).toContain("without producing an answer");
  });
});

describe("a delegated run that will not stop", () => {
  it("is capped, rather than running until the parent's budget is gone", async () => {
    // A model looping on a tool it cannot get right. Without a ceiling this
    // never returns, and the parent's turn sits on it.
    provider.script(() => ({ call: { name: "ls", args: {} } }));

    const result = await runDelegatedTask(
      await context(workspace()),
      "loop forever",
      () => undefined
    );

    expect(result.stoppedBy).toBe("turn-limit");
    expect(result.turns).toBeGreaterThan(1);
  }, 120_000);

  it("tells the parent the answer is incomplete", async () => {
    // Text and a tool call together, so there IS a partial answer to mislabel.
    provider.script(() => ({
      say: "a partial finding",
      call: { name: "ls", args: {} },
    }));

    const result = await runDelegatedTask(
      await context(workspace()),
      "loop forever",
      () => undefined
    );

    // Returning the last message alone would present an interrupted run as a
    // finished one, and the parent would report it as the answer.
    expect(result.text).toMatch(/did not finish/i);
    expect(result.text).toContain("incomplete");
  }, 120_000);
});

describe("a delegated run the user stops", () => {
  it("ends promptly on abort instead of running on", async () => {
    // A model that would loop forever; only the abort ends it. The tool's
    // signal used to be dropped on the floor, so Stop left the sub-agent
    // working until the turn ceiling or the 15-minute clock.
    const controller = new AbortController();

    // Abort once the run is demonstrably underway — from the responder, so
    // the timing does not depend on how fast the fake provider loops.
    provider.script((_call, index) => {
      if (index === 2) controller.abort();

      return { call: { name: "ls", args: {} } };
    });

    const started = Date.now();
    const result = await runDelegatedTask(
      await context(workspace()),
      "loop forever",
      () => undefined,
      controller.signal
    );

    expect(result.stoppedBy).toBe("aborted");
    // Far under the run's own bounds: it stopped on the signal, not a limit.
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("returns at once when the signal is already aborted", async () => {
    const controller = new AbortController();

    controller.abort();

    const result = await runDelegatedTask(
      await context(workspace()),
      "anything",
      () => undefined,
      controller.signal
    );

    expect(result.stoppedBy).toBe("aborted");
  }, 60_000);

  it("leaves no abort listener behind on the run's signal", async () => {
    // One controller per RUN, not per tool call — every delegation in a turn
    // shares this signal, so a listener that is never removed accumulates for
    // as long as the run lasts and holds each delegation's closure with it.
    const controller = new AbortController();

    provider.script(() => ({ say: "done" }));

    for (let call = 0; call < 3; call += 1) {
      await runDelegatedTask(
        await context(workspace()),
        "say done",
        () => undefined,
        controller.signal
      );
    }

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  }, 120_000);
});

describe("a delegated run that fails", () => {
  it("reports a provider failure as text instead of throwing", async () => {
    provider.script(() => ({
      fail: { status: 402, message: "this account has no credit" },
    }));

    // Never throws: a failed delegation is a tool failure the parent can adapt
    // to, not a reason to tear down a turn that has other work in it.
    const result = await runDelegatedTask(
      await context(workspace()),
      "do something",
      () => undefined
    );

    expect(result.stoppedBy).not.toBe("completed");
    expect(result.text.length).toBeGreaterThan(0);
  }, 120_000);

  it("says why, rather than shrugging", async () => {
    provider.script(() => ({
      fail: { status: 402, message: "this account has no credit" },
    }));

    const result = await runDelegatedTask(
      await context(workspace()),
      "do something",
      () => undefined
    );

    // A provider call that fails outright is not a retry, so the run ends
    // normally with nothing said. Reporting "finished without producing an
    // answer" hands the parent a shrug and drops the one useful sentence.
    expect(result.text).not.toContain("without producing an answer");
    expect(result.text).toMatch(/credit|could not run/i);
  }, 120_000);
});

describe("what the sub-agent is allowed", () => {
  it("cannot delegate again", async () => {
    provider.script(() => ({ say: "done" }));

    await runDelegatedTask(
      await context(workspace()),
      "anything",
      () => undefined
    );

    // Depth is where delegation stops being an optimisation and becomes a way
    // to spend a budget in a loop.
    expect(provider.firstCall?.tools ?? []).not.toContain("delegate_task");
  });

  it("has the file and shell tools it needs to do the work", async () => {
    provider.script(() => ({ say: "done" }));

    await runDelegatedTask(
      await context(workspace()),
      "anything",
      () => undefined
    );

    expect(provider.firstCall?.tools ?? []).toEqual(
      expect.arrayContaining(["read", "write", "edit", "bash"])
    );
  });
});

describe("what the user switched off", () => {
  it("stays off inside the sub-agent", async () => {
    // The Capabilities toggles used to stop at the parent: with the shell off,
    // `delegate_task` handed the sub-agent a working `bash` and it ran. Every
    // tool the panel can withhold was reachable the same way.
    process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = "bash,run_tests";

    try {
      provider.script(() => ({ say: "done" }));
      await runDelegatedTask(
        await context(workspace()),
        "anything",
        () => undefined
      );

      expect(provider.firstCall?.tools ?? []).not.toContain("bash");
      expect(provider.firstCall?.tools ?? []).not.toContain("run_tests");
    } finally {
      delete process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;
    }
  });

  it("leaves everything else in place", async () => {
    process.env.ABACUSAI_BOT_EXCLUDED_TOOLS = "bash";

    try {
      provider.script(() => ({ say: "done" }));
      await runDelegatedTask(
        await context(workspace()),
        "anything",
        () => undefined
      );

      expect(provider.firstCall?.tools ?? []).toEqual(
        expect.arrayContaining(["read", "edit", "write"])
      );
    } finally {
      delete process.env.ABACUSAI_BOT_EXCLUDED_TOOLS;
    }
  });
});
