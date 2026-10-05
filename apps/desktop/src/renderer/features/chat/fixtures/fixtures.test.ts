import type { AguiEvent } from "@abacus-ai/agent";
/**
 * R2-T29 (spec 02 §11): the copied agent goldens equal their sources; every
 * builder scenario uses only the event types and custom names the agent
 * (or main) emits; the canvas boards of pages 1–4 each have a scenario;
 * every scenario replays to readiness through the real runtime.
 */
import { describe, expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

import { GOLDEN_NAMES, goldenText } from "./goldens";
import { fixtureRuntime } from "./player";
import { SCENARIOS } from "./scenarios";

const SOURCES = readSourceFiles(
  "../../../../../../../packages/agent/src/agui/__fixtures__/*.agui.jsonl",
  import.meta.dirname
);

const withSeqs = (text: string): string =>
  `${text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) =>
      JSON.stringify({ seq: index + 1, event: JSON.parse(line) })
    )
    .join("\n")}\n`;

/** The emitted vocabulary (agent spec §2.3, main relay notes). */
const TYPES = new Set<string>([
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_END",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "CUSTOM",
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
  "SUBAGENT_ERROR",
] satisfies readonly `${AguiEvent["type"]}`[]);
const CUSTOM = new Set([
  "session.ready",
  "session.cleared",
  "wire.hello",
  "agent.status",
  "agent.heartbeat",
  "agent.error",
  "agent.notification",
  "agent.retry",
  "run.ack",
  "permission.requested",
  "permission.resolved",
  "permission.cleared",
  "permission.response_rejected",
  "permission.pending",
  "tool.output",
  "tool.display",
  "queue.updated",
  "queue.steered",
  "queue.dequeued",
  "queue.command_rejected",
  "skills.loaded",
  "mcp.servers",
  "mcp.server_logs",
  "abacus.duplicate_echo",
  "abacus.notice",
]);

const BOARDS = [
  "BotChat",
  "BotChatScrolled",
  "SessionRunning",
  "BotApproval",
  "BotChatPanel",
  "BotChannel",
  "BotStates",
  "BotDetails",
  "Main",
  "MainCollapsed",
  "FullView",
  "FullViewFocused",
  "SplitView",
  "SubAgents",
  "SessionFailed",
  "SessionBrowser",
  "SessionReview",
  "SessionWorkspaceMissing",
  "ComposerStates",
  "PermissionStates",
  "Pickers",
  "ReadOnlyStates",
];

describe("R2-T29 fixtures", () => {
  it("copies equal their sources", () => {
    const names = Object.keys(SOURCES)
      .map((path) => /([^/]+)\.agui\.jsonl$/.exec(path)![1]!)
      .sort();
    expect(GOLDEN_NAMES).toEqual(names);
    for (const [path, text] of Object.entries(SOURCES)) {
      const name = /([^/]+)\.agui\.jsonl$/.exec(path)![1]!;
      expect(goldenText(name), name).toBe(withSeqs(text));
    }
  });

  it("builder scenarios speak the emitted vocabulary", () => {
    for (const scenario of SCENARIOS)
      for (const { event } of scenario.events()) {
        expect(TYPES.has(event.type), `${scenario.id}: ${event.type}`).toBe(
          true
        );
        if (event.type === "CUSTOM") {
          const name = (event as { name: string }).name;
          expect(CUSTOM.has(name), `${scenario.id}: ${name}`).toBe(true);
        }
      }
  });

  it("every canvas board has a scenario and ids are unique", () => {
    const covered = new Set(SCENARIOS.flatMap((scenario) => scenario.canvas));
    expect(BOARDS.filter((board) => !covered.has(board))).toEqual([]);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  it("every scenario replays to readiness", async () => {
    for (const scenario of SCENARIOS) {
      const fixture = fixtureRuntime(scenario.id)!;
      const session = fixture.runtime.session(fixture.threadId);
      await session.load();
      expect(session.ready, scenario.id).toBe(true);
      expect(session.positions()?.reconstructed, scenario.id).toBe(true);
      fixture.runtime.forget(fixture.threadId);
    }
  });
});
