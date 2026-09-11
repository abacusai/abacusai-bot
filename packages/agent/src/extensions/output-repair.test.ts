import { fakePi, type FakeTool } from "@abacus-ai/test-support/fake-pi";
/**
 * Repairing a call to a tool that does not exist.
 *
 * Two paths reach the model with "that tool does not exist", and they are not
 * the same path. A tool that exists but rejects the call comes back through
 * `tool_result`, where the advice can be appended to the result. A name that is
 * not in the registry at all never gets that far: the agent loop answers it
 * from `prepareToolCall` and skips the step where the `tool_result` hook runs,
 * so the only signal is `tool_execution_end`.
 *
 * The second is the case the repair exists for, and the one it used to miss.
 */
import { describe, expect, it } from "vitest";

import { default as outputRepair } from "./output-repair.js";

const stubTool = (name: string): FakeTool => ({
  name,
  description: name,
  parameters: {},
  async execute() {
    return { content: [{ type: "text", text: "" }] };
  },
});

function withRepair(toolNames = ["present_deliverable", "web_search", "read"]) {
  const pi = fakePi();
  for (const name of toolNames)
    (pi.api as { registerTool(t: FakeTool): void }).registerTool(
      stubTool(name)
    );
  outputRepair(pi.api as never);

  return pi;
}

const notFound = (toolName: string) => ({
  toolCallId: "call-1",
  toolName,
  isError: true,
  result: { content: [{ type: "text", text: `Tool ${toolName} not found` }] },
});

describe("a name that is not a tool at all", () => {
  it("answers on tool_execution_end, where the only signal arrives", async () => {
    const pi = withRepair();
    await pi.fire("tool_execution_end", notFound("present_deliverabl"));

    expect(pi.messages).toHaveLength(1);
    expect(String(pi.messages[0]?.content)).toContain("present_deliverable");
  });

  it("lists the tools that do exist", async () => {
    const pi = withRepair();
    await pi.fire("tool_execution_end", notFound("nonsense_tool"));

    const text = String(pi.messages[0]?.content);
    expect(text).toContain("Available tools:");
    expect(text).toContain("web_search");
  });

  it("suggests the tool the name was reaching for", async () => {
    const pi = withRepair();
    // The real failure: the hand-off text named the tool without its prefix.
    await pi.fire(
      "tool_execution_end",
      notFound("agent-tools_present_deliverable")
    );

    expect(String(pi.messages[0]?.content)).toContain(
      "Did you mean `present_deliverable`?"
    );
  });

  it("stays quiet when the tool succeeded", async () => {
    const pi = withRepair();
    await pi.fire("tool_execution_end", {
      ...notFound("read"),
      isError: false,
    });

    expect(pi.messages).toHaveLength(0);
  });

  it("stays quiet for an error that is not about a missing tool", async () => {
    const pi = withRepair();
    await pi.fire("tool_execution_end", {
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT: no such file" }] },
    });

    expect(pi.messages).toHaveLength(0);
  });
});

describe("a tool that exists and rejected the call", () => {
  it("appends the advice to the result rather than sending a message", async () => {
    const pi = withRepair();
    const result = (await pi.fire("tool_result", {
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "unknown tool: reed" }],
    })) as { content: Array<{ text: string }> };

    expect(result.content.at(-1)?.text).toContain("Available tools:");
    expect(pi.messages).toHaveLength(0);
  });

  it("does not also nudge when tool_execution_end follows", async () => {
    const pi = withRepair();
    const event = {
      toolCallId: "call-1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "unknown tool: reed" }],
    };

    // pi's real order: afterToolCall (tool_result) runs inside
    // finalizeExecutedToolCall, before emitToolExecutionEnd.
    await pi.fire("tool_result", event);
    await pi.fire("tool_execution_end", {
      ...event,
      result: { content: event.content },
    });

    expect(pi.messages).toHaveLength(0);
  });
});
