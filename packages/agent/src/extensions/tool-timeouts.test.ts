import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The budget only means anything if it reaches the call. pi's bash tool
 * documents "no default timeout", so an unstamped call is one that can park
 * the session until someone presses Stop, and an unattended session has
 * nobody to press it.
 */
import { describe, expect, it, vi } from "vitest";

import {
  budgetSecondsFor,
  mcpCallBudgetSeconds,
  default as toolTimeouts,
  withCallBudget,
} from "./tool-timeouts.js";

function withTimeouts() {
  const pi = fakePi();
  toolTimeouts(pi.api as never);

  return pi;
}

/** A tool_call event; the extension mutates `input` in place, as pi sanctions. */
function bashCall(input: Record<string, unknown>) {
  return { toolName: "bash", toolCallId: "call-1", input };
}

describe("stamping a deadline", () => {
  it("gives bash a default budget, since pi ships none", async () => {
    const pi = withTimeouts();
    const event = bashCall({ command: "sleep 999" });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(120);
  });

  // The reported case: `npx create-next-app` was killed at exactly 120s with
  // most of the work done. Two minutes is right for a command that hung; it
  // is wrong for one whose job is to download a dependency tree.
  it("gives an install or a scaffold the install budget", async () => {
    // A Windows installer or a dependency tree on a slow network runs for many
    // minutes and still succeeds; at 600s it was killed mid-install.
    const pi = withTimeouts();
    for (const command of [
      "cd /tmp && npx --yes create-next-app@latest chess-game --ts",
      "npm install next react react-dom",
      "pnpm add -D vitest",
      "pip install -r requirements.txt",
      "git clone https://example.com/repo.git",
      "winget install --id MiKTeX.MiKTeX --accept-source-agreements",
      "composer create-project laravel/laravel app",
    ]) {
      const event = bashCall({ command });
      await pi.fire("tool_call", event);
      expect(event.input.timeout).toBe(1800);
    }
  });

  it("lets an explicit budget on an install reach the install ceiling, and no further", async () => {
    const pi = withTimeouts();
    const event = bashCall({ command: "pip install torch", timeout: 9_999 });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(1800);
  });

  it("still gives an ordinary command the short budget", async () => {
    const pi = withTimeouts();
    for (const command of ["ls -la", "npm run build", "cat package.json"]) {
      const event = bashCall({ command });
      await pi.fire("tool_call", event);
      expect(event.input.timeout).toBe(120);
    }
  });

  it("honours a budget the model set deliberately", async () => {
    // A model may genuinely know the build takes eight minutes.
    const pi = withTimeouts();
    const event = bashCall({ command: "npm ci", timeout: 300 });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(300);
  });

  it("leaves a backgrounded command alone", async () => {
    // The deadline is the thing being escaped. Stamping 120s on a command the
    // model deliberately backgrounded would kill a twenty-minute build at two
    // minutes, and this extension has no idea what was asked for.
    const pi = withTimeouts();
    const event = bashCall({ command: "npm run build", background: true });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBeUndefined();
  });

  it("still honours a deadline set on a backgrounded command", async () => {
    // Not invented, but not ignored either: an explicit budget is still the
    // model saying something it may well know.
    const pi = withTimeouts();
    const event = bashCall({
      command: "npm run build",
      background: true,
      timeout: 300,
    });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(300);
  });

  it('still caps an absurd one: "wins" cannot mean "may park forever"', async () => {
    const pi = withTimeouts();
    const event = bashCall({ command: "x", timeout: 99_999 });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(600);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["not a number", "soon"],
  ])("replaces a %s budget with the default", async (_label, timeout) => {
    const pi = withTimeouts();
    const event = bashCall({ command: "x", timeout });
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBe(120);
  });

  it("leaves alone a tool with no deadline parameter of its own", async () => {
    // Stamping a `timeout` onto a tool whose schema has no such field would
    // send the model an argument it never declared.
    const pi = withTimeouts();
    const event = {
      toolName: "read",
      toolCallId: "r1",
      input: { path: "a.ts" } as Record<string, unknown>,
    };
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBeUndefined();
  });

  it("does not fight run_tests, which enforces its own default", async () => {
    const pi = withTimeouts();
    const event = {
      toolName: "run_tests",
      toolCallId: "t1",
      input: {} as Record<string, unknown>,
    };
    await pi.fire("tool_call", event);

    expect(event.input.timeout).toBeUndefined();
  });
});

describe("declared budgets", () => {
  it("reads a budget from the tool that owns it", () => {
    expect(budgetSecondsFor("bash")).toBe(120);
    expect(budgetSecondsFor("read_output")).toBe(15);
  });

  it("falls back for a tool with no entry, so a typo cannot disable a budget", () => {
    // Budgets live with the tool rather than in user config precisely so an
    // unrecognised name gets the default instead of silently getting none.
    expect(budgetSecondsFor("some_mcp_tool")).toBe(180);
  });

  it("gives an MCP tool call its budget: a connector's default, or the tool's own", () => {
    expect(mcpCallBudgetSeconds("abacus-connectors_Gmail_Tool")).toBe(90);
    expect(mcpCallBudgetSeconds("pdf")).toBe(300);
    expect(mcpCallBudgetSeconds("image_generate")).toBe(360);
  });

  it("stops an MCP call before the watchdog would report on it", () => {
    // MCP tools are not in the table by name, so the watchdog arms for them
    // at the default; the call must be over by then.
    expect(mcpCallBudgetSeconds("any_server_any_tool")).toBeLessThan(
      budgetSecondsFor("any_server_any_tool")
    );
  });
});

describe("the watchdog", () => {
  it("tells the user and the model when a call blows its budget", async () => {
    vi.useFakeTimers();
    try {
      const pi = withTimeouts();
      await pi.fire("tool_execution_start", {
        toolName: "read_output",
        toolCallId: "w1",
        args: {},
      });

      // read_output declares 15s. Push past it.
      await vi.advanceTimersByTimeAsync(16_000);

      // The user hears about it while it is still running, because a tool that
      // has stopped responding looks identical to a hung app otherwise.
      expect(pi.notifications).toHaveLength(1);
      expect(pi.notifications[0]!.text).toMatch(/read_output/);
      expect(pi.notifications[0]!.level).toBe("warning");

      await pi.fire("tool_execution_end", {
        toolName: "read_output",
        toolCallId: "w1",
        result: {},
        isError: false,
      });
      const result = (await pi.fire("tool_result", {
        toolName: "read_output",
        toolCallId: "w1",
        isError: false,
        content: [{ type: "text", text: "eventually done" }],
      })) as { content: Array<{ text: string }> };

      // And the model is told, so it treats the call as expensive rather than
      // repeating it. The original content survives ahead of the note.
      expect(result.content[0]!.text).toBe("eventually done");
      expect(result.content[1]!.text).toMatch(/longer than its 15s budget/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing about a call that finished in time", async () => {
    vi.useFakeTimers();
    try {
      const pi = withTimeouts();
      await pi.fire("tool_execution_start", {
        toolName: "read_output",
        toolCallId: "w2",
        args: {},
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await pi.fire("tool_execution_end", {
        toolName: "read_output",
        toolCallId: "w2",
        result: {},
        isError: false,
      });

      const result = await pi.fire("tool_result", {
        toolName: "read_output",
        toolCallId: "w2",
        isError: false,
        content: [{ type: "text", text: "ok" }],
      });

      expect(pi.notifications).toHaveLength(0);
      expect(result).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not watch a tool that enforces its own deadline", async () => {
    vi.useFakeTimers();
    try {
      const pi = withTimeouts();
      // bash gets a stamped timeout and pi kills the process itself, so a
      // watchdog on top would only produce a second, redundant warning.
      await pi.fire("tool_execution_start", {
        toolName: "bash",
        toolCallId: "w3",
        args: {},
      });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(pi.notifications).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timers at the end of a turn", async () => {
    vi.useFakeTimers();
    try {
      const pi = withTimeouts();
      await pi.fire("tool_execution_start", {
        toolName: "read",
        toolCallId: "w4",
        args: {},
      });
      await pi.fire("turn_end", {});
      await vi.advanceTimersByTimeAsync(120_000);

      // A turn that ended takes its watchdogs with it: no warning about a
      // call nobody is waiting for any more.
      expect(pi.notifications).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // "Command timed out after 120 seconds" leaves the model with one idea:
  // run the same command again, and "re-run it with a larger timeout" only
  // makes the wait longer. Say what would actually work, and to tell the user.
  it("tells the model what to do about a killed command", async () => {
    const pi = withTimeouts();
    const result = (await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "npm run build" },
      content: [{ type: "text", text: "Command timed out after 120 seconds" }],
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("Command timed out after 120 seconds");
    const remedy = result.content[1]!.text;
    expect(remedy).not.toMatch(/Re-run it with a larger/);
    expect(remedy).toMatch(/Do not run it again with a larger `timeout`/);
    expect(remedy).toMatch(/Tell the user in one line that this is slow/);
    expect(remedy).toMatch(/a faster way: a narrower path, a depth limit/);
    expect(result.content[1]!.text).toMatch(
      /never for an install or a scaffold/
    );
  });

  it("does not offer more time to a command already killed at its ceiling", async () => {
    // An install killed at 1800 cannot be given more; "raise the timeout"
    // would send the model round the same loop.
    const pi = withTimeouts();
    const result = (await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "call-1",
      input: { command: "winget install --id MiKTeX.MiKTeX" },
      content: [{ type: "text", text: "Command timed out after 1800 seconds" }],
    })) as { content: Array<{ text: string }> };

    expect(result.content[1]!.text).not.toMatch(/larger `timeout`/);
    expect(result.content[1]!.text).toMatch(/1800 seconds is the most/);
  });

  it("leaves a call that is stopped at its budget to that, with no note on top", async () => {
    vi.useFakeTimers();
    try {
      const pi = withTimeouts();
      await pi.fire("tool_execution_start", {
        toolName: "web_search",
        toolCallId: "w5",
        args: {},
      });
      await vi.advanceTimersByTimeAsync(600_000);

      expect(pi.notifications).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a bash result that did not time out alone", async () => {
    const pi = withTimeouts();
    const result = await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "call-1",
      content: [{ type: "text", text: "total 0" }],
    });

    expect(result).toBeUndefined();
  });
});

describe("a call held to its budget", () => {
  /** A tool that does whatever `run` does with the signal it is handed. */
  const tool = (run: (signal?: AbortSignal) => Promise<string>) =>
    withCallBudget(
      {
        name: "slow_tool",
        execute: async (
          _id: string,
          _params: Record<string, unknown>,
          signal?: AbortSignal
        ) => run(signal),
      },
      90
    );

  it("answers a fast call as it came", async () => {
    await expect(tool(async () => "done").execute("c", {})).resolves.toBe(
      "done"
    );
  });

  it("aborts the tool's signal at the budget and fails the call with a lead for the model", async () => {
    vi.useFakeTimers();
    try {
      let seen: AbortSignal | undefined;
      const call = tool(
        (signal) =>
          new Promise((_resolve, reject) => {
            seen = signal;
            signal?.addEventListener("abort", () => reject(signal.reason));
          })
      ).execute("c", {});
      const settled = expect(call).rejects.toThrow(
        "slow_tool did not answer within 90s, so the call was stopped. Carry on without it"
      );

      await vi.advanceTimersByTimeAsync(89_000);
      expect(seen?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      await settled;
      expect(seen?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers at the budget even when the tool ignores its signal", async () => {
    vi.useFakeTimers();
    try {
      const call = tool(() => new Promise(() => {})).execute("c", {});
      const settled = expect(call).rejects.toThrow("did not answer within 90s");

      await vi.advanceTimersByTimeAsync(90_000);

      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes Stop through to the tool at once", async () => {
    const stop = new AbortController();
    const call = tool(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    ).execute("c", {}, stop.signal);

    stop.abort();

    await expect(call).rejects.toThrow("aborted");
  });
});
