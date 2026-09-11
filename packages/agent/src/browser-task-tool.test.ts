/**
 * What the Agents card is told when a browser run stops. The run itself is
 * stubbed: under test is the translation from its stop reason to the card's
 * verdict and the model's result, which must agree with each other.
 */
import { describe, expect, it, vi } from "vitest";

import type { BrowserTaskResult } from "./browser-task.js";
import type { AgentEvent } from "./protocol.js";

const stubs = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("./browser-task.js", () => ({ runBrowserTask: stubs.run }));

const { buildBrowserTaskTool } = await import("./browser-task-tool.js");

const run = async (stoppedBy: BrowserTaskResult["stoppedBy"]) => {
  stubs.run.mockResolvedValue({ text: "the report", turns: 3, stoppedBy });
  const events: AgentEvent[] = [];
  const tool = buildBrowserTaskTool({ cwd: process.cwd() } as never, (event) =>
    events.push(event)
  );
  const result = await tool.execute("call-1", { task: "look something up" });
  const status = events.find((event) => event.type === "subtask_end")?.status;
  return { status, result };
};

describe("a browser run's card", () => {
  it("is completed when the run stopped for the user with a report", async () => {
    const { status, result } = await run("needs-user");
    expect(status).toBe("completed");
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toMatch(/continue_from_last/);
  });

  it("is completed when the run hit its cap with a partial report", async () => {
    for (const stoppedBy of ["turn-limit", "timeout"] as const) {
      const { status, result } = await run(stoppedBy);
      expect(status).toBe("completed");
      expect(result.isError).toBe(false);
      expect(result.content[0]?.text).toMatch(/may be incomplete/);
    }
  });

  it("is failed only when the run produced nothing usable", async () => {
    for (const stoppedBy of ["error", "provider-error", "aborted"] as const) {
      const { status, result } = await run(stoppedBy);
      expect(status).toBe("failed");
      expect(result.isError).toBe(true);
    }
  });
});
