import {
  fakePi,
  type FakePi,
  type FakeTool,
} from "@abacus-ai/test-support/fake-pi";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
/**
 * The argument, and the promise it makes.
 *
 * `background: true` is worth having only if two things hold: the call comes
 * back before the command does, and the agent is told when the command lands.
 * The first is easy to get right and easy to break by awaiting the wrong
 * promise; the second is the one that fails silently, because a notification
 * that never arrives looks exactly like a job that is still running.
 */
import { afterEach, describe, expect, it } from "vitest";

import { withBackgroundOption } from "./background-bash.js";
import {
  listBackgroundJobs,
  notifyConversationQueueCleared,
  resetBackgroundJobs,
  onBackgroundReport,
  type BackgroundReport,
} from "./background-processes.js";
import { default as backgroundExtension } from "./extensions/background.js";

const operations = createLocalBashOperations();

/** A stand-in for pi's bash: records what the foreground path forwarded to it. */
function fakeBash(): {
  definition: Record<string, unknown>;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    definition: {
      name: "bash",
      label: "bash",
      description: "Execute a bash command.",
      parameters: {
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
        },
      },
      execute: async (_id: string, params: Record<string, unknown>) => {
        calls.push(params);

        return {
          content: [{ type: "text", text: "foreground ran" }],
          details: {},
        };
      },
    },
  };
}

const bashTool = () => {
  const base = fakeBash();
  const tool = withBackgroundOption(
    base.definition as never,
    process.cwd(),
    operations
  ) as unknown as {
    description: string;
    parameters: { properties: Record<string, unknown> };
    execute: (
      id: string,
      params: Record<string, unknown>
    ) => Promise<{
      content: Array<{ text: string }>;
      isError?: boolean;
    }>;
  };

  return { tool, base };
};

const run = async (
  tool: ReturnType<typeof bashTool>["tool"],
  params: Record<string, unknown>
): Promise<string> =>
  (await tool.execute("call-1", params)).content
    .map((block) => block.text)
    .join("\n");

afterEach(() => {
  resetBackgroundJobs();
});

describe("the foreground path", () => {
  it("is handed straight to pi, unchanged", async () => {
    const { tool, base } = bashTool();

    expect(await run(tool, { command: "echo hi", timeout: 120 })).toBe(
      "foreground ran"
    );
    expect(base.calls).toEqual([{ command: "echo hi", timeout: 120 }]);
  });

  it("does not forward an argument pi has never heard of", async () => {
    // pi validates against its own schema, so `background: false` reaching it
    // is a rejected tool call rather than a command that runs.
    const { tool, base } = bashTool();
    await run(tool, { command: "echo hi", background: false });

    expect(base.calls[0]).not.toHaveProperty("background");
  });

  it("keeps pi's own schema alongside the new argument", () => {
    const { tool } = bashTool();

    expect(Object.keys(tool.parameters.properties).sort()).toEqual([
      "background",
      "command",
      "timeout",
    ]);
  });
});

describe("the background path", () => {
  it("returns while the command is still running", async () => {
    const { tool, base } = bashTool();
    const out = await run(tool, { command: "sleep 30", background: true });

    expect(out).toContain("Started bg-1 in the background");
    // pi's foreground execute must not have been touched: awaiting it is
    // exactly the bug this argument exists to avoid.
    expect(base.calls).toEqual([]);
    expect(listBackgroundJobs()[0]?.exit).toBeNull();
  });

  it("refuses a command that is not text at all", async () => {
    // Schema validation is pi's, and this path runs before it does.
    const { tool } = bashTool();
    const result = await tool.execute("call-1", {
      command: 42,
      background: true,
    });

    expect(result.isError).toBe(true);
    expect(listBackgroundJobs()).toEqual([]);
  });

  it("passes a deadline through when one was asked for", async () => {
    // Backgrounding drops the automatic budget; an explicit one still counts.
    const { tool } = bashTool();

    await run(tool, { command: "sleep 30", timeout: 1, background: true });
    await waitFor(() => listBackgroundJobs()[0]?.exit != null, 15_000);

    expect(listBackgroundJobs()[0]?.exit).not.toBeNull();
  });

  it("refuses an empty command rather than starting a shell for nothing", async () => {
    const { tool } = bashTool();
    const result = await bashTool().tool.execute("call-1", {
      command: "   ",
      background: true,
    });

    expect(result.isError).toBe(true);
    expect(await run(tool, { command: "  ", background: true })).toContain(
      "A command is required"
    );
  });
});

/** The extension is what turns a finished job into something the agent reads. */
function withExtension(): FakePi {
  const pi = fakePi();
  backgroundExtension(pi.api as never);
  loaded.push(pi);

  return pi;
}

/** Each one listens to the shared registry until its session ends. */
const loaded: FakePi[] = [];

afterEach(async () => {
  for (const pi of loaded.splice(0)) {
    await pi.fire("session_shutdown", { type: "session_shutdown" });
  }
});

const getFirstJobOutput = (): string | undefined =>
  listBackgroundJobs()[0]?.output;

const waitFor = async (predicate: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("being told it finished", () => {
  it("starts no turn for a job that lands with nothing running", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const reports: BackgroundReport[] = [];
    const stop = onBackgroundReport((report) => reports.push(report));

    await run(tool, { command: "echo build complete", background: true });
    await waitFor(() => pi.messages.length > 0);
    stop();

    const [message] = pi.messages;

    expect(String(message?.content)).toContain("build complete");
    // A run nobody asked for bills them and reaches no chat: it goes on the
    // record for their next message, and the app tells them.
    expect(message?.options).toBeUndefined();
    expect(reports).toEqual([
      { id: "bg-1", command: "echo build complete", outcome: "finished" },
    ]);
  });

  it("hands a job that lands mid-turn to that turn, and tells nobody else", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const reports: BackgroundReport[] = [];
    const stop = onBackgroundReport((report) => reports.push(report));

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo landed", background: true });
    await waitFor(() => pi.messages.length > 0);
    await pi.fire("turn_start", { type: "turn_start" });
    await pi.fire("agent_settled", { type: "agent_settled" });
    stop();

    expect(String(pi.messages[0]?.content)).toContain("landed");
    expect(pi.messages[0]?.options).toEqual({ deliverAs: "steer" });
    expect(pi.messages).toHaveLength(1);
    expect(reports).toEqual([]);
  });

  it("tells the person of one steered too late for the reply to carry it", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const reports: BackgroundReport[] = [];
    const stop = onBackgroundReport((report) => reports.push(report));

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo late", background: true });
    await waitFor(() => pi.messages.length > 0);
    await pi.fire("agent_settled", { type: "agent_settled" });
    stop();

    expect(pi.messages).toHaveLength(1);
    expect(reports.map((report) => report.outcome)).toEqual(["finished"]);
  });

  it("names a run its own timeout stopped, rather than a failure", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const reports: BackgroundReport[] = [];
    const stop = onBackgroundReport((report) => reports.push(report));

    await run(tool, { command: "sleep 30", timeout: 1, background: true });
    await waitFor(() => pi.messages.length > 0, 15_000);
    stop();

    expect(String(pi.messages[0]?.content)).toContain("timeout you gave it");
    expect(reports.map((report) => report.outcome)).toEqual(["timed-out"]);
  });

  it("says so when the command failed, with its exit code", async () => {
    const pi = withExtension();
    const { tool } = bashTool();

    await run(tool, { command: "echo nope >&2; exit 2", background: true });
    await waitFor(() => pi.messages.length > 0);

    expect(String(pi.messages[0]?.content)).toContain("failed (exit 2)");
    expect(String(pi.messages[0]?.content)).toContain("nope");
  });

  it("stays quiet about a job the agent killed on purpose", async () => {
    // It already knows: it asked. Waking a turn to say so is noise the user
    // pays for.
    const pi = withExtension();
    const { tool } = bashTool();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });
    await killTool.execute("call-2", { id: "bg-1" });
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(pi.messages).toEqual([]);
  });
});

describe("surviving a stop", () => {
  /**
   * The queue a follow-up sits in is cleared when a turn is stopped (on
   * purpose), because one that survives Stop is a Stop button that halts the
   * reply and lets the agent carry straight on. A build that finished at that
   * moment must not be swept up with it, so the news is held here until
   * something actually picks it up.
   */
  it("says it again after a stop swallowed the first attempt", async () => {
    const pi = withExtension();
    const { tool } = bashTool();

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo survived", background: true });
    await waitFor(() => pi.messages.length > 0);

    // What `stop()` does: empty the queue, and say so. The handover no longer
    // counts, so it goes on the record when the turn has settled.
    notifyConversationQueueCleared();
    await pi.fire("agent_settled", { type: "agent_settled" });

    expect(pi.messages).toHaveLength(2);
    expect(String(pi.messages[1]?.content)).toContain("survived");
    // Never a turn of its own: that would be a Stop that starts the agent.
    expect(pi.messages[1]?.options).toBeUndefined();
  });

  it("does not say it twice once a turn has taken it", async () => {
    const pi = withExtension();
    const { tool } = bashTool();

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo once", background: true });
    await waitFor(() => pi.messages.length > 0);

    // A step starting is the proof it was taken.
    await pi.fire("turn_start", { type: "turn_start" });
    await pi.fire("agent_settled", { type: "agent_settled" });
    await pi.fire("input", { type: "input" });

    expect(pi.messages).toHaveLength(1);
  });

  it("keeps a job that landed after the handover", async () => {
    // Only what was actually sent is dropped on consumption. A second job
    // finishing in the gap is still owed an announcement.
    const pi = withExtension();
    const { tool } = bashTool();

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo first", background: true });
    await waitFor(() => pi.messages.length > 0);
    await run(tool, { command: "echo second", background: true });
    await waitFor(() => pi.messages.length > 1);

    expect(String(pi.messages.at(-1)?.content)).toContain("second");
    expect(String(pi.messages.at(-1)?.content)).not.toContain("first");
  });
});

describe("fetch_background_output", () => {
  it("reads a job that is still running", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await run(tool, { command: "echo working; sleep 30", background: true });
    await waitFor(() => (getFirstJobOutput() ?? "").includes("working"));

    const out =
      (await fetchTool.execute("call-2", { id: "bg-1" })).content[0]?.text ??
      "";

    expect(out).toContain("running");
    expect(out).toContain("working");
  });

  it("reads a job that has finished", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await run(tool, { command: "echo all done; exit 0", background: true });
    await waitFor(() => listBackgroundJobs()[0]?.exit != null);

    const out =
      (await fetchTool.execute("call-2", { id: "bg-1" })).content[0]?.text ??
      "";

    expect(out).toContain("exited (code 0)");
    expect(out).toContain("all done");
  });

  it("lists everything when given no id", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });
    await run(tool, { command: "sleep 30", background: true });

    const out = (await fetchTool.execute("call-2", {})).content[0]?.text ?? "";

    expect(out).toContain("bg-1");
    expect(out).toContain("bg-2");
  });

  it("says so plainly when nothing has been started", async () => {
    const pi = withExtension();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    expect((await fetchTool.execute("call-2", {})).content[0]?.text).toContain(
      "Nothing has been started"
    );
  });

  it("reports an id it does not know as an error", async () => {
    const pi = withExtension();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;
    const result = await fetchTool.execute("call-2", { id: "bg-99" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "No background process with id bg-99"
    );
  });

  it("drops the pending announcement once the agent has read it", async () => {
    // Reading it yourself is being told. Announcing it afterwards would report
    // a result the agent has already acted on.
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo read by hand", background: true });
    await waitFor(() => pi.messages.length > 0);

    // A Stop handed it back, so it is waiting again.
    notifyConversationQueueCleared();
    await fetchTool.execute("call-2", { id: "bg-1" });
    await pi.fire("agent_settled", { type: "agent_settled" });

    expect(pi.messages).toHaveLength(1);
  });

  it("does not swallow an unsent notice when an earlier one is read", async () => {
    // The regression: notices used to be dropped by position ("the first n
    // went out"), and reading one removes it from the middle, so the count
    // then discarded a notice that had never been sent. That job finished and
    // was never mentioned again.
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await pi.fire("turn_start", { type: "turn_start" });
    await run(tool, { command: "echo alpha", background: true });
    await waitFor(() => pi.messages.length > 0);
    await run(tool, { command: "echo beta", background: true });
    await waitFor(() => pi.messages.length > 1);

    // A Stop hands both back; reading the first takes it from the list.
    notifyConversationQueueCleared();
    await fetchTool.execute("call-2", { id: "bg-1" });
    await pi.fire("agent_settled", { type: "agent_settled" });

    expect(String(pi.messages.at(-1)?.content)).toContain("beta");
    expect(String(pi.messages.at(-1)?.content)).not.toContain("alpha");
  });
});

describe("output too big to hand over whole", () => {
  it("keeps the tail, and says the rest was dropped", async () => {
    // The verdict is at the end: a failing build's error is its last lines,
    // not its first, so the front is what goes.
    const pi = withExtension();
    const { tool } = bashTool();

    await run(tool, {
      command:
        'for i in $(seq 1 400); do echo "line $i padding padding padding padding"; done; echo THE_LAST_LINE',
      background: true,
    });
    await waitFor(() => pi.messages.length > 0, 15_000);

    const content = String(pi.messages[0]?.content);

    expect(content).toContain("earlier output dropped");
    expect(content).toContain("THE_LAST_LINE");
    expect(content).not.toContain("line 1 padding");
  });
});

describe("the session going away", () => {
  it("stops everything and stops listening", async () => {
    const pi = withExtension();
    const { tool } = bashTool();

    await run(tool, { command: "sleep 30", background: true });
    await pi.fire("session_shutdown", { type: "session_shutdown" });

    expect(listBackgroundJobs()[0]?.exit?.killed).toBe(true);
    // Unsubscribed, so a later job cannot announce itself into a dead session.
    expect(pi.messages).toEqual([]);
  });
});

describe("kill_process", () => {
  it("stops one by id", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });
    const result = await killTool.execute("call-2", { id: "bg-1" });

    expect(result.content[0]?.text).toContain("Stopped bg-1");
    await waitFor(() => listBackgroundJobs()[0]?.exit != null);
  });

  it("stops everything when given no id", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });
    await run(tool, { command: "sleep 30", background: true });

    expect((await killTool.execute("call-3", {})).content[0]?.text).toContain(
      "2 processes"
    );
  });

  it("says there was nothing to stop rather than pretending", async () => {
    const pi = withExtension();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    expect((await killTool.execute("call-4", {})).content[0]?.text).toContain(
      "Nothing was running"
    );
  });

  it("reports an id it does not know as an error", async () => {
    const pi = withExtension();
    const killTool = pi.tools.get("kill_process") as FakeTool;
    const result = await killTool.execute("call-5", { id: "bg-99" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "No background process with id bg-99"
    );
  });

  it("says a job already finished rather than claiming to have stopped it", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "true", background: true });
    await waitFor(() => listBackgroundJobs()[0]?.exit != null);

    expect(
      (await killTool.execute("call-6", { id: "bg-1" })).content[0]?.text
    ).toContain("had already finished");
  });
});

describe("how a job reads at each stage", () => {
  it("shows a running job that has not printed yet", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });

    expect(
      (await fetchTool.execute("call-2", { id: "bg-1" })).content[0]?.text
    ).toContain("nothing printed yet");
  });

  it("distinguishes a finished job that printed nothing", async () => {
    // "nothing yet" and "nothing at all" are different answers, and a build
    // that produced no output is a result rather than a wait.
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;

    await run(tool, { command: "true", background: true });
    await waitFor(() => listBackgroundJobs()[0]?.exit != null);

    expect(
      (await fetchTool.execute("call-2", { id: "bg-1" })).content[0]?.text
    ).toContain("it printed nothing");
  });

  it("shows a killed job as stopped, not as an exit code", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const fetchTool = pi.tools.get("fetch_background_output") as FakeTool;
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });
    await killTool.execute("call-2", { id: "bg-1" });

    expect(
      (await fetchTool.execute("call-3", { id: "bg-1" })).content[0]?.text
    ).toContain("stopped");
  });

  it("counts one stopped process as one, not as 1 processes", async () => {
    const pi = withExtension();
    const { tool } = bashTool();
    const killTool = pi.tools.get("kill_process") as FakeTool;

    await run(tool, { command: "sleep 30", background: true });

    expect((await killTool.execute("call-2", {})).content[0]?.text).toContain(
      "1 process:"
    );
  });
});
