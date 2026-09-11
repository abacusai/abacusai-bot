/**
 * What the agent was doing, as the log file records it.
 *
 * A report arrives without a transcript — the transcript is the user's own
 * work — so these lines are the only account of the run a maintainer gets.
 * Each case is a question that used to be unanswerable from a dump: which
 * model, which tool call, why it was refused, what the provider said.
 *
 * The other half is what must NOT be here: streamed text and thinking are the
 * transcript, and logging them would both bury the diagnosis and ship the
 * user's work to whoever reads the bundle.
 */
import { describe, expect, it } from "vitest";

import type { AgentEvent, DesktopEvent } from "#shared/agent-types";

import { describeAgentEvent } from "./agent-event-log";

const SESSION = "abcd1234-5678-90ab-cdef-1234567890ab";

const line = (event: unknown): string | null =>
  describeAgentEvent(SESSION, {
    type: "event",
    event: event as AgentEvent,
  } as DesktopEvent);

const tool = (name: string, input: Record<string, unknown> = {}) => ({
  id: "call-1",
  name,
  type: name,
  input,
});

describe("what gets written", () => {
  it("names the model the session started on", () => {
    expect(
      describeAgentEvent(SESSION, {
        type: "ready",
        model: "openllm/auto",
        mode: "DEFAULT",
      } as DesktopEvent)
    ).toBe("[abcd1234] ready model=openllm/auto mode=DEFAULT");
  });

  it("records a model change, which is what a router does mid-turn", () => {
    expect(line({ type: "model_changed", model: "openrouter/x" })).toBe(
      "[abcd1234] model=openrouter/x"
    );
  });

  it("records which tool ran, and on what", () => {
    expect(
      line({
        type: "tool_execution_start",
        tool: tool("bash", { command: "pnpm build" }),
      })
    ).toBe("[abcd1234] tool start bash#call-1 command=pnpm build");
  });

  it("records a failed tool call with the reason it gave", () => {
    const text = line({
      type: "tool_execution_complete",
      tool: tool("write", { path: "/repo/x.ts" }),
      result: { content: "EACCES: permission denied", rejected: true },
    });

    expect(text).toContain("tool FAILED write#call-1");
    expect(text).toContain("path=/repo/x.ts");
    expect(text).toContain("EACCES: permission denied");
  });

  it("records the provider error, however the model spelled it", () => {
    expect(
      line({
        type: "error",
        error: {
          code: "turn_failed",
          segmentData: { message: "429 upstream" },
        },
      })
    ).toBe("[abcd1234] error[turn_failed] 429 upstream");
  });

  it("keeps what the provider itself said behind the app's reading of it", () => {
    // "The model provider had a problem (400)" is what a support report
    // arrives with, and on its own there is nothing in it to diagnose.
    expect(
      line({
        type: "error",
        error: {
          code: "turn_failed",
          message:
            "The model provider had a problem (400). Try again, or switch to a different model.",
          detail: "input too large for this model: 41231 > 32768",
        },
      })
    ).toBe(
      "[abcd1234] error[turn_failed] The model provider had a problem (400). " +
        "Try again, or switch to a different model. :: provider said: " +
        "input too large for this model: 41231 > 32768"
    );
  });

  it("records retries, which are otherwise a silent pause", () => {
    expect(
      line({
        type: "retry",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2000,
        isNetworkError: true,
      })
    ).toBe("[abcd1234] retry 1/3 in 2000ms (network)");
  });

  it("records what the agent asked permission for", () => {
    expect(
      line({
        type: "permission_needed",
        permissionId: "perm-1",
        tool: tool("bash", { command: "rm -rf build" }),
      })
    ).toContain("permission asked bash bash command=rm -rf build");
  });

  it("records an MCP server that failed to connect, and why", () => {
    expect(
      describeAgentEvent(SESSION, {
        type: "mcp_server_status",
        serverId: "github",
        status: "error",
        error: "spawn npx ENOENT",
      } as unknown as DesktopEvent)
    ).toBe("[abcd1234] mcp github error error=spawn npx ENOENT");
  });
});

describe("what stays out", () => {
  it("drops streamed text and thinking — that is the transcript", () => {
    expect(line({ type: "text_delta", content: "Sure, I can" })).toBeNull();
    expect(line({ type: "thinking_delta", content: "hmm" })).toBeNull();
  });

  it("drops the per-token chatter a log would drown in", () => {
    expect(line({ type: "status_changed", status: "streaming" })).toBeNull();
    expect(
      line({ type: "tool_output_update", toolCallId: "c", output: "..." })
    ).toBeNull();
  });

  it("keeps a long argument from taking the whole line", () => {
    const text = line({
      type: "tool_execution_start",
      tool: tool("bash", { command: "x".repeat(500) }),
    });

    expect(text?.length).toBeLessThan(250);
    expect(text?.endsWith("…")).toBe(true);
  });

  it("never carries a file's contents, only its path", () => {
    const text = line({
      type: "tool_execution_start",
      tool: tool("write", {
        path: "/repo/secret-plans.ts",
        content: "the user's actual work",
      }),
    });

    expect(text).toContain("/repo/secret-plans.ts");
    expect(text).not.toContain("the user's actual work");
  });
});
