/**
 * The plan tool, as the agent registers it.
 *
 * The contract these pin is cross-surface: the desktop serves `todo` over MCP
 * from mcp-agent-tools-server.ts, and a model that learned the tool there must
 * find the same one here. So the wire name, the two actions, the validation
 * messages and the rendered output are all asserted rather than assumed.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { setTodos } from "./todo-store.js";
import { buildTodoTool, TODO_TOOL_NAME } from "./todo-tool.js";

const tool = buildTodoTool();
const run = async (
  params: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> => {
  const result = await tool.execute("call-1", params);

  return {
    text: result.content[0]?.text ?? "",
    isError: result.isError === true,
  };
};

beforeEach(() => {
  setTodos([]);
});

describe("the tool the model sees", () => {
  it("is named the same as the one the desktop serves", () => {
    // Renaming this silently would leave a model trained on one surface calling
    // a tool that does not exist on the other.
    expect(TODO_TOOL_NAME).toBe("todo");
    expect(tool.name).toBe("todo");
  });
});

describe("setting and reading a plan", () => {
  it("starts empty and says so rather than returning nothing", async () => {
    expect((await run({ action: "list" })).text).toBe("The plan is empty.");
  });

  it("renders each status with its own marker", async () => {
    const { text } = await run({
      action: "set",
      todos: [
        { content: "Read the code", status: "completed" },
        { content: "Write the fix", status: "in_progress" },
        { content: "Run the tests", status: "pending" },
      ],
    });

    expect(text).toContain("[x] Read the code");
    expect(text).toContain("[~] Write the fix");
    expect(text).toContain("[ ] Run the tests");
  });

  it("keeps the plan between calls", async () => {
    await run({
      action: "set",
      todos: [{ content: "Only step", status: "pending" }],
    });

    expect((await run({ action: "list" })).text).toContain("[ ] Only step");
  });
});

describe("what it refuses", () => {
  it("rejects more than one item in progress", async () => {
    // A plan with two things happening at once has stopped describing what is
    // actually happening, which is the only thing it is for.
    const { text, isError } = await run({
      action: "set",
      todos: [
        { content: "First", status: "in_progress" },
        { content: "Second", status: "in_progress" },
      ],
    });

    expect(isError).toBe(true);
    expect(text).toContain("Only one todo can be in_progress at a time.");
  });

  it("rejects an unknown status instead of storing it", async () => {
    const { text, isError } = await run({
      action: "set",
      todos: [{ content: "Something", status: "nearly" }],
    });

    expect(isError).toBe(true);
    expect(text).toContain("invalid status");
  });

  it("rejects empty content", async () => {
    const { isError } = await run({
      action: "set",
      todos: [{ content: "   ", status: "pending" }],
    });

    expect(isError).toBe(true);
  });

  it("rejects an unknown action rather than guessing", async () => {
    const { text, isError } = await run({ action: "append" });

    expect(isError).toBe(true);
    expect(text).toContain('action must be "set" or "list".');
  });

  it("leaves the previous plan intact when a write is rejected", async () => {
    await run({
      action: "set",
      todos: [{ content: "Good step", status: "pending" }],
    });
    await run({
      action: "set",
      todos: [{ content: "Bad step", status: "wrong" }],
    });

    expect((await run({ action: "list" })).text).toContain("[ ] Good step");
  });
});
