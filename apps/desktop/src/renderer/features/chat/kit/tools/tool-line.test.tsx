/** R2-T12/T13: real widget dispatch for open tool/agent names and expanders. */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeMemoryRelays,
  memoryRelay,
} from "#renderer/test-support/chat-relay";

import * as b from "../../fixtures/builders";
import { renderRelay } from "../../testing";

let current: Awaited<ReturnType<typeof renderRelay>> | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  closeMemoryRelays();
});

describe("R2-T12/T13 rendered tool rows", () => {
  it("an MCP tool and unknown sub-agent retain the default widget context in nested Parts", async () => {
    const relay = await memoryRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r"),
      b.textStart("a"),
      ...b.toolCall("mcp", "mcp__linear__create_issue", "a", {
        title: "Fix anchoring",
      }),
      b.toolResult("mcp", { text: "Issue created" }),
      b.subagentStarted(
        "child",
        "new_agent_kind",
        "Nested child",
        "parent",
        "a"
      ),
      ...b
        .text("child-message", "assistant", "Nested assistant text")
        .map((event) => ({ ...event, subagentRunId: "child" })),
      ...b
        .toolCall("nested", "mcp__new_server__read", "child-message", {
          id: "42",
        })
        .map((event) => ({ ...event, subagentRunId: "child" })),
      b.toolResult(
        "nested",
        { text: "Nested tool result" },
        { subagentRunId: "child" }
      ),
      b.subagentFinished("child", "done"),
      b.textEnd("a"),
      b.runFinished("r"),
    ]);
    current = await renderRelay(relay, "session");
    const parent = await screen.findByRole("button", {
      name: /linear|create.issue/i,
    });
    fireEvent.click(parent);
    expect(await screen.findByText("Issue created")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Nested child/ }));
    expect(await screen.findByText("Nested assistant text")).toBeTruthy();
    expect(document.querySelectorAll("[data-tool]")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /new.server|read/i }));
    expect(await screen.findByText("Nested tool result")).toBeTruthy();
  });

  it("live bash output is replaced by its terminal result in the expander", async () => {
    const relay = await memoryRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r"),
      b.textStart("a"),
      ...b.toolCall("bash", "bash", "a", { command: "printf hello" }),
      b.custom("tool.output", { toolCallId: "bash", output: "live line" }),
    ]);
    current = await renderRelay(relay, "session");
    fireEvent.click(
      await screen.findByRole("button", { name: /printf hello/ })
    );
    expect(await screen.findByText("live line")).toBeTruthy();
    relay.emitAll([
      b.toolResult("bash", {
        text: "final line",
        terminal: { output: "final line" },
      }),
      b.textEnd("a"),
      b.runFinished("r"),
    ]);
    expect(await screen.findByText("final line")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("live line")).toBeNull());
    expect(document.querySelector('[data-status="done"]')).toBeTruthy();
  });
});
