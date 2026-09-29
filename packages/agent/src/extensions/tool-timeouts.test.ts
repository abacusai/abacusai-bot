import { fakePi } from "@abacus-ai/test-support/fake-pi";
/**
 * The budget only means anything if it reaches the call. pi's bash tool
 * documents "no default timeout", so an unstamped call is one that can park
 * the session until someone presses Stop, and an unattended session has
 * nobody to press it.
 */
import { describe, expect, it, vi } from "vitest";

import { budgetSecondsFor, default as toolTimeouts } from "./tool-timeouts.js";

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
  it("gives an install or a scaffold the full ceiling", async () => {
    const pi = withTimeouts();
    for (const command of [
      "cd /tmp && npx --yes create-next-app@latest chess-game --ts",
      "npm install next react react-dom",
      "pnpm add -D vitest",
      "pip install -r requirements.txt",
      "git clone https://example.com/repo.git",
    ]) {
      const event = bashCall({ command });
      await pi.fire("tool_call", event);
      expect(event.input.timeout).toBe(600);
    }
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
  // run the same command again. Say what would actually work.
  it("tells the model what to do about a killed command", async () => {
    const pi = withTimeouts();
    const result = (await pi.fire("tool_result", {
      toolName: "bash",
      toolCallId: "call-1",
      content: [{ type: "text", text: "Command timed out after 120 seconds" }],
    })) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("Command timed out after 120 seconds");
    expect(result.content[1]!.text).toMatch(/larger `timeout`/);
    expect(result.content[1]!.text).toMatch(
      /never for an install or a scaffold/
    );
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
