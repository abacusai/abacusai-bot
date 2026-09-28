import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The bridge between the local agent host and the vendored reducer.
 *
 * The host speaks the legacy tool vocabulary and the reducer speaks the current
 * one, so every tool the agent runs passes through a translation here. When it
 * is wrong the failure is silent and total (a card with no command line, an
 * edit with no diff, a sub-agent's work spilling into the main transcript), so
 * the mapping is worth pinning in both directions, along with what the bridge
 * does with input it does not recognise.
 */
import { AgentMode } from "#shared/agent-types";

import { WorkspaceConversationTransport } from "./transport";
import type { ConversationEvent } from "./types";

const WORKSPACE = "workspace-1";
const SESSION = "session-1";

/** Every agent IPC method the transport reaches for, as spies. */
const agentApi = {
  sendAgentMessage: vi.fn(async () => undefined),
  stopAgentTurn: vi.fn(async () => undefined),
  respondAgentPermission: vi.fn(async () => undefined),
  enqueueAgentMessage: vi.fn(async () => undefined),
  dequeueAgentMessage: vi.fn(async () => undefined),
  removeAgentQueueMessage: vi.fn(async () => undefined),
  updateAgentQueueMessage: vi.fn(async () => undefined),
  clearAgentQueue: vi.fn(async () => undefined),
  getAgentQueue: vi.fn(async () => undefined),
  setAgentModel: vi.fn(async () => undefined),
  setAgentMode: vi.fn(async () => undefined),
  resetAgentConversation: vi.fn(async () => undefined),
  listAgentSessions: vi.fn(async () => [] as { id: string; label: string }[]),
  updateAgentSessionLabel: vi.fn(async () => undefined),
};

let transport: WorkspaceConversationTransport;
let emitted: ConversationEvent[];

/** The loop events forwarded to the reducer, unwrapped from their envelopes. */
const loopEvents = (): Record<string, unknown>[] =>
  emitted
    .filter((event) => event.kind === "event")
    .map((event) => (event as { event: Record<string, unknown> }).event);

/** Feed one NDJSON line the way the `local-cli-ndjson` subscription does. */
const ingest = (payload: unknown): void => {
  transport.ingest(WORKSPACE, SESSION, payload);
};

/** Feed one loop event, already wrapped in the host's `event` envelope. */
const ingestEvent = (event: unknown): void => {
  ingest({ type: "event", event });
};

const toolRequest = (
  id: string,
  name: string,
  input: Record<string, unknown> = {}
): Record<string, unknown> => ({ id, name, type: name, input });

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { api: unknown }).api = { agent: agentApi };
  transport = new WorkspaceConversationTransport();
  transport.registerSession(SESSION, WORKSPACE);
  emitted = [];
  transport.subscribe((_conversationId, event) => {
    emitted.push(event);
  });
});

describe("what the bridge refuses to act on", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "tool_execution_start"],
    ["a number", 7],
  ])("ignores a payload that is %s", (_label, payload) => {
    ingest(payload);

    expect(emitted).toEqual([]);
  });

  it("ignores a message type it has no opinion about", () => {
    // The host broadcasts far more than this layer consumes; ready, mcp_*,
    // update_* and friends must pass by without producing anything.
    for (const type of ["ready", "skills_loaded", "mcp_servers", "update_ok"]) {
      ingest({ type, payload: {} });
    }

    expect(emitted).toEqual([]);
  });

  it("ignores an event envelope with no event in it", () => {
    ingestEvent(null);
    ingestEvent(undefined);

    expect(emitted).toEqual([]);
  });

  it("drops permission_request, which travels on the side-channel instead", () => {
    ingestEvent({ type: "permission_request", permissionId: "p1" });

    expect(emitted).toEqual([]);
  });

  it("ignores a permission_needed with no request", () => {
    ingest({ type: "permission_needed", permissionId: "p1", request: null });

    expect(emitted).toEqual([]);
  });
});

describe("passing through what the reducer already speaks", () => {
  it.each([
    ["text_delta", { type: "text_delta", text: "hello" }],
    ["status_changed", { type: "status_changed", status: "idle" }],
    ["thinking_delta", { type: "thinking_delta", text: "hmm" }],
    ["error", { type: "error", message: "boom" }],
  ])("forwards %s unchanged", (_label, event) => {
    ingestEvent(event);

    expect(loopEvents()).toEqual([event]);
  });

  it("preserves the order events arrived in", () => {
    ingestEvent({ type: "text_delta", text: "one" });
    ingestEvent({ type: "text_delta", text: "two" });
    ingestEvent({ type: "text_delta", text: "three" });

    expect(loopEvents().map((event) => event.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });
});

describe("the permission side-channel", () => {
  it("raises a prompt and remembers the id the tool call answers by", async () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });

    expect(emitted).toEqual([
      { kind: "permission", prompt: { request: expect.anything() } },
    ]);

    // The join is only observable through responding: the CLI is addressed by
    // permissionId, while the conversation answers by the tool call's id.
    await transport.respondToPermission(SESSION, "call-1", "approve" as never);

    expect(agentApi.respondAgentPermission).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      permissionId: "p1",
      decision: "approve",
    });
  });

  it("retires the prompt itself, since the host sends no counterpart", async () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    emitted = [];

    await transport.respondToPermission(SESSION, "call-1", "approve" as never);

    expect(emitted).toEqual([{ kind: "permission", prompt: null }]);
  });

  it("does nothing for a tool call it never recorded a permission for", async () => {
    await transport.respondToPermission(SESSION, "unknown", "approve" as never);

    expect(agentApi.respondAgentPermission).not.toHaveBeenCalled();
    expect(emitted).toEqual([]);
  });

  it("answers a permission only once", async () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    await transport.respondToPermission(SESSION, "call-1", "approve" as never);
    await transport.respondToPermission(SESSION, "call-1", "approve" as never);

    expect(agentApi.respondAgentPermission).toHaveBeenCalledTimes(1);
  });

  it("takes the card down when the request in the slot expires", () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    emitted = [];

    ingestEvent({ type: "permission_cleared", permissionId: "p1" });

    expect(emitted).toEqual([{ kind: "permission", prompt: null }]);
  });

  it("leaves the live card alone when an older request expires under it", () => {
    // Two approvals in flight: the second owns the slot, and blanking it would
    // drop the prompt the user is actually looking at.
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    ingest({
      type: "permission_needed",
      permissionId: "p2",
      request: { tool: toolRequest("call-2", "bash") },
    });
    emitted = [];

    ingestEvent({ type: "permission_cleared", permissionId: "p1" });

    expect(emitted).toEqual([]);
  });

  it("stops the expired request from being answerable", async () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    ingestEvent({ type: "permission_cleared", permissionId: "p1" });

    await transport.respondToPermission(SESSION, "call-1", "approve" as never);

    expect(agentApi.respondAgentPermission).not.toHaveBeenCalled();
  });

  it("ignores a permission_cleared that names no request", () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });
    emitted = [];

    ingestEvent({ type: "permission_cleared" });

    expect(emitted).toEqual([]);
  });
});

describe("the message queue", () => {
  it("forwards a queue snapshot", () => {
    const entries = [{ id: "0", message: "first" }];

    ingest({ type: "queue_updated", messages: entries });

    expect(emitted).toEqual([{ kind: "queue", entries }]);
  });

  it("reads a snapshot with no messages as an empty queue", () => {
    ingest({ type: "queue_updated" });

    expect(emitted).toEqual([{ kind: "queue", entries: [] }]);
  });

  it("sends a queued message by removing it and re-sending its text", async () => {
    ingest({
      type: "queue_updated",
      messages: [
        { id: "a", message: "first" },
        { id: "b", message: "second" },
      ],
    });
    emitted = [];

    await transport.sendQueuedMessage(SESSION, "b");

    expect(agentApi.removeAgentQueueMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      index: 1,
    });
    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      message: "second",
    });
    // Echoed the way the composer does, so the message appears as the user's.
    expect(emitted).toContainEqual({ kind: "user_message", content: "second" });
  });

  it("does not echo a hidden queued message", async () => {
    ingest({
      type: "queue_updated",
      messages: [{ id: "a", message: "internal", hidden: true }],
    });
    emitted = [];

    await transport.sendQueuedMessage(SESSION, "a");

    expect(emitted).not.toContainEqual(
      expect.objectContaining({ kind: "user_message" })
    );
    expect(agentApi.sendAgentMessage).toHaveBeenCalled();
  });

  it("removes by index when no snapshot has arrived to look the id up in", async () => {
    await transport.sendQueuedMessage(SESSION, "2");

    expect(agentApi.removeAgentQueueMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      index: 2,
    });
    // Nothing to re-send: the entry's text was never in a snapshot.
    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled();
  });
});

describe("translating the host's tool events", () => {
  it("turns a start into a tool_call carrying the announced arguments", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls -a" }),
    });

    expect(loopEvents()).toEqual([
      {
        type: "tool_call",
        toolCall: {
          id: "call-1",
          name: "bash",
          args: { command: "ls -a" },
          status: "executing",
        },
      },
    ]);
  });

  it("reads the arguments from `args` when `input` is absent", () => {
    // The host populates both; either one alone must still produce the args.
    ingestEvent({
      type: "tool_execution_start",
      tool: { id: "call-1", name: "bash", args: { command: "pwd" } },
    });

    expect(loopEvents()[0]).toMatchObject({
      toolCall: { args: { command: "pwd" } },
    });
  });

  it("drops a start with no tool id, which nothing could be attached to", () => {
    ingestEvent({ type: "tool_execution_start", tool: { name: "bash" } });

    expect(emitted).toEqual([]);
  });

  it("keeps the start event's arguments when the result lands", () => {
    // The completion event rebuilds its request with EMPTY args, and the
    // reducer replaces the card with the result's toolCall, so without the
    // join every finished bash card would lose its command line.
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls -a" }),
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "bash"),
      result: { content: "a\nb\n" },
    });

    expect(loopEvents()[1]).toEqual({
      type: "tool_result",
      toolCall: {
        id: "call-1",
        name: "bash",
        args: { command: "ls -a" },
        status: "executing",
      },
      result: {
        toolCallId: "call-1",
        output: "a\nb\n",
        data: { type: "bash", command: "ls -a", output: "a\nb\n" },
      },
    });
  });

  it("falls back to the completion's own request when no start was seen", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read", { path: "/tmp/x" }),
      result: { content: "contents" },
    });

    expect(loopEvents()[0]).toMatchObject({
      toolCall: { name: "read", args: { path: "/tmp/x" } },
      result: { toolCallId: "call-1", output: "contents" },
    });
  });

  it("drops a completion with no tool id", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: { name: "bash" },
      result: { content: "x" },
    });

    expect(emitted).toEqual([]);
  });

  it("reads a missing or non-string result content as empty output", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read"),
      result: {},
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-2", "read"),
      result: { content: { nested: true } },
    });

    expect(loopEvents().map((event) => event.result)).toEqual([
      { toolCallId: "call-1", output: "" },
      { toolCallId: "call-2", output: "" },
    ]);
  });

  it("reports a rejected call as an error carrying the reason", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read"),
      result: { content: "The user rejected this tool call", rejected: true },
    });

    expect(loopEvents()[0]).toMatchObject({
      result: { error: "The user rejected this tool call" },
    });
  });

  it("gives a rejected call with no message a generic one", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read"),
      result: { content: "", rejected: true },
    });

    expect(loopEvents()[0]).toMatchObject({
      result: { error: "The tool call failed." },
    });
  });

  it("marks no error on a call that succeeded", () => {
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read"),
      result: { content: "fine", rejected: false },
    });

    expect(loopEvents()[0]).toMatchObject({ result: { output: "fine" } });
    expect((loopEvents()[0] as { result: object }).result).not.toHaveProperty(
      "error"
    );
  });

  it("forgets a tool once its result has been reported", () => {
    // A second completion for the same id must not still find the start's call.
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls" }),
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "bash"),
      result: { content: "" },
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "bash"),
      result: { content: "" },
    });

    expect(loopEvents()[2]).toMatchObject({ toolCall: { args: {} } });
  });
});

describe("display data, which arrives before the tool does", () => {
  it("emits nothing of its own", () => {
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { originalContent: "old", newContent: "new" },
    });

    expect(emitted).toEqual([]);
  });

  it("survives the start event that arrives after it", () => {
    // Sent at permission time, before the tool is tracked. Losing it strips
    // edit cards of their diff.
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { originalContent: "old", newContent: "new", additions: 2 },
    });
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "edit", { path: "/tmp/f" }),
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "edit"),
      result: { content: "done" },
    });

    expect(loopEvents()[1]).toMatchObject({
      result: {
        data: {
          type: "file_mutation",
          originalContent: "old",
          finalContent: "new",
          additions: 2,
        },
      },
    });
  });

  it("merges what several display-data events said", () => {
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { originalContent: "old" },
    });
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { isNewFile: false, deletions: 1 },
    });
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "write"),
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "write"),
      result: { content: "" },
    });

    expect(loopEvents()[1]).toMatchObject({
      result: {
        data: { originalContent: "old", isNewFile: false, deletions: 1 },
      },
    });
  });

  it("prefers newContent, falling back to finalContent", () => {
    for (const [id, data, expected] of [
      ["a", { newContent: "N", finalContent: "F" }, "N"],
      ["b", { finalContent: "F" }, "F"],
    ] as const) {
      ingestEvent({ type: "tool_display_data", toolCallId: id, data });
      ingestEvent({
        type: "tool_execution_start",
        tool: toolRequest(id, "write"),
      });
      ingestEvent({
        type: "tool_execution_complete",
        tool: toolRequest(id, "write"),
        result: { content: "" },
      });

      expect(loopEvents().at(-1)).toMatchObject({
        result: { data: { finalContent: expected } },
      });
    }
  });

  it("ignores display data with no tool call id", () => {
    ingestEvent({ type: "tool_display_data", toolCallId: "", data: {} });
    ingestEvent({ type: "tool_display_data", data: {} });

    expect(emitted).toEqual([]);
  });

  it("attaches no payload to a tool that renders plain text", () => {
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { newContent: "irrelevant" },
    });
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "read"),
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "read"),
      result: { content: "text" },
    });

    expect((loopEvents()[1] as { result: object }).result).not.toHaveProperty(
      "data"
    );
  });

  it("does not let a display-data placeholder stand in for a real call", () => {
    // A placeholder has an empty name; the completion's own request is better.
    ingestEvent({
      type: "tool_display_data",
      toolCallId: "call-1",
      data: { newContent: "new" },
    });
    ingestEvent({
      type: "tool_execution_complete",
      tool: toolRequest("call-1", "write", { path: "/tmp/f" }),
      result: { content: "" },
    });

    expect(loopEvents()[0]).toMatchObject({
      toolCall: { name: "write", args: { path: "/tmp/f" } },
    });
  });
});

describe("streaming a running command's output", () => {
  it("renders live output as a terminal card addressed by tool call id", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "npm test" }),
    });
    ingestEvent({
      type: "tool_output_update",
      toolCallId: "call-1",
      output: "running…",
    });

    // `streaming` is what keeps the card in its running state: the command
    // has not finished, and its completion arrives separately.
    expect(loopEvents()[1]).toEqual({
      type: "terminal_command",
      cmdline: "npm test",
      output: "running…",
      toolCallId: "call-1",
      streaming: true,
    });
  });

  it("ignores output for a tool it is not tracking", () => {
    ingestEvent({
      type: "tool_output_update",
      toolCallId: "unknown",
      output: "x",
    });

    expect(emitted).toEqual([]);
  });

  it("ignores output for a tool that is not a shell command", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "read", { path: "/tmp/f" }),
    });
    emitted = [];

    ingestEvent({
      type: "tool_output_update",
      toolCallId: "call-1",
      output: "x",
    });

    expect(emitted).toEqual([]);
  });

  it("ignores output for a bash call with no command line", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "" }),
    });
    emitted = [];

    ingestEvent({
      type: "tool_output_update",
      toolCallId: "call-1",
      output: "x",
    });

    expect(emitted).toEqual([]);
  });

  it("ignores an update whose output is not a string", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls" }),
    });
    emitted = [];

    ingestEvent({ type: "tool_output_update", toolCallId: "call-1" });

    expect(emitted).toEqual([]);
  });
});

describe("attributing work to an open sub-agent", () => {
  const openBracket = (id: string): void => {
    ingestEvent({ type: "subtask_start", id, kind: "task" });
  };

  it.each([["text_delta"], ["thinking_delta"], ["collapsible"]])(
    "stamps %s with the open bracket",
    (type) => {
      openBracket("sub-1");
      ingestEvent({ type, text: "inside" });

      expect(loopEvents().at(-1)).toMatchObject({ subtaskId: "sub-1" });
    }
  );

  it.each([
    ["status_changed", { type: "status_changed", status: "idle" }],
    ["error", { type: "error", message: "boom" }],
    ["notification", { type: "notification", message: "hi" }],
  ])("leaves %s on the main surface, where it can be seen", (_label, event) => {
    openBracket("sub-1");
    emitted = [];

    ingestEvent(event);

    expect(loopEvents()[0]).not.toHaveProperty("subtaskId");
  });

  it("stamps a sub-agent's tool calls and terminal output too", () => {
    openBracket("sub-1");
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls" }),
    });
    ingestEvent({
      type: "tool_output_update",
      toolCallId: "call-1",
      output: "x",
    });

    expect(loopEvents()[1]).toMatchObject({ subtaskId: "sub-1" });
    expect(loopEvents()[2]).toMatchObject({ subtaskId: "sub-1" });
  });

  it("does not overwrite an attribution the event already carries", () => {
    openBracket("sub-1");
    ingestEvent({ type: "text_delta", text: "x", subtaskId: "sub-other" });

    expect(loopEvents().at(-1)).toMatchObject({ subtaskId: "sub-other" });
  });

  it("attributes to the innermost bracket when two are open", () => {
    // A component agent can run two sub-agents at once; with a single slot the
    // second start silently stole the first's children.
    openBracket("sub-1");
    openBracket("sub-2");
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).toMatchObject({ subtaskId: "sub-2" });
  });

  it("returns to the sibling still running when the inner bracket closes", () => {
    openBracket("sub-1");
    openBracket("sub-2");
    ingestEvent({ type: "subtask_end", id: "sub-2" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).toMatchObject({ subtaskId: "sub-1" });
  });

  it("keeps the inner bracket when an outer one closes first", () => {
    openBracket("sub-1");
    openBracket("sub-2");
    ingestEvent({ type: "subtask_end", id: "sub-1" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).toMatchObject({ subtaskId: "sub-2" });
  });

  it("does not stack a repeated start for one sub-agent twice", () => {
    openBracket("sub-1");
    openBracket("sub-1");
    ingestEvent({ type: "subtask_end", id: "sub-1" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });

  it("returns content to the main transcript once the bracket closes", () => {
    openBracket("sub-1");
    ingestEvent({ type: "subtask_end", id: "sub-1" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });

  it("forwards the brackets themselves as they are", () => {
    const start = { type: "subtask_start", id: "sub-1", kind: "task" };
    const end = { type: "subtask_end", id: "sub-1" };

    ingestEvent(start);
    ingestEvent(end);

    expect(loopEvents()).toEqual([start, end]);
  });

  it("ignores a bracket event with no id", () => {
    ingestEvent({ type: "subtask_start" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });

  it("closes an unfinished bracket at the turn boundary", () => {
    // An id kept past its turn stamps the NEXT turn's text with a dead bracket,
    // which the views then filter out entirely: a blank turn.
    openBracket("sub-1");
    ingestEvent({ type: "turn_complete" });
    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });

  it("forgets a tool that never reported a result at the turn boundary", () => {
    ingestEvent({
      type: "tool_execution_start",
      tool: toolRequest("call-1", "bash", { command: "ls" }),
    });
    ingestEvent({ type: "turn_complete" });
    emitted = [];

    ingestEvent({
      type: "tool_output_update",
      toolCallId: "call-1",
      output: "x",
    });

    expect(emitted).toEqual([]);
  });
});

describe("forcing the session back to idle on Stop", () => {
  it("drops the prompt and declares the session idle", () => {
    transport.markIdle(SESSION);

    expect(emitted).toEqual([
      { kind: "permission", prompt: null },
      { kind: "event", event: { type: "status_changed", status: "idle" } },
    ]);
  });

  it("closes a bracket Stop was pressed inside", () => {
    // Stop is the only end this turn gets: the subtask_end that would retire
    // the bracket is suppressed, so leaving it open blanks every later turn.
    ingestEvent({ type: "subtask_start", id: "sub-1", kind: "task" });
    transport.markIdle(SESSION);
    emitted = [];

    ingestEvent({ type: "text_delta", text: "x" });

    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });
});

describe("sessions the transport does not know", () => {
  const commands: [string, (id: string | null) => Promise<unknown>][] = [
    ["sendMessage", (id) => transport.sendMessage(id, "hi")],
    ["stopProcessing", (id) => transport.stopProcessing(id)],
    ["enqueueMessage", (id) => transport.enqueueMessage(id, "hi")],
    ["dequeueMessages", (id) => transport.dequeueMessages(id)],
    ["removeQueuedMessage", (id) => transport.removeQueuedMessage(id, "0")],
    ["clearQueue", (id) => transport.clearQueue(id)],
    ["selectConversation", (id) => transport.selectConversation(id)],
    ["clearConversation", (id) => transport.clearConversation(id)],
    ["sendQueuedMessage", (id) => transport.sendQueuedMessage(id, "0")],
  ];

  it.each(commands)(
    "%s is a no-op for an unregistered session",
    async (_name, run) => {
      // The UI can race a session teardown, so a command for a gone session must
      // not throw.
      await expect(run("no-such-session")).resolves.not.toThrow();

      for (const spy of Object.values(agentApi)) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  );

  it.each(commands)(
    "%s is a no-op for a null conversation",
    async (_name, run) => {
      await expect(run(null)).resolves.not.toThrow();

      for (const spy of Object.values(agentApi)) {
        expect(spy).not.toHaveBeenCalled();
      }
    }
  );

  it("forgets everything it held for a session that goes away", async () => {
    ingest({
      type: "permission_needed",
      permissionId: "p1",
      request: { tool: toolRequest("call-1", "bash") },
    });

    transport.forgetSession(SESSION);
    await transport.sendMessage(SESSION, "hi");
    await transport.respondToPermission(SESSION, "call-1", "approve" as never);

    expect(agentApi.sendAgentMessage).not.toHaveBeenCalled();
    expect(agentApi.respondAgentPermission).not.toHaveBeenCalled();
  });
});

describe("commands for a session it does know", () => {
  it("addresses the CLI by the workspace and session pair", async () => {
    await transport.sendMessage(SESSION, "hello");

    expect(agentApi.sendAgentMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      message: "hello",
    });
  });

  it("reports no dequeued message when stopping", async () => {
    await expect(transport.stopProcessing(SESSION)).resolves.toEqual({
      dequeuedMessage: null,
    });
    expect(agentApi.stopAgentTurn).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
    });
  });

  it("passes the hidden flag through only when it was set", async () => {
    await transport.enqueueMessage(SESSION, "a");
    await transport.enqueueMessage(SESSION, "b", { hidden: true });

    expect(agentApi.enqueueAgentMessage).toHaveBeenNthCalledWith(1, {
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      message: "a",
    });
    expect(agentApi.enqueueAgentMessage).toHaveBeenNthCalledWith(2, {
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      message: "b",
      hidden: true,
    });
  });

  it("removes a queued message by its id once a snapshot has arrived", async () => {
    ingest({
      type: "queue_updated",
      messages: [
        { id: "q-7", message: "first", waitingFor: "step" },
        { id: "q-8", message: "second", waitingFor: "step" },
      ],
    });

    await transport.removeQueuedMessage(SESSION, "q-8");

    expect(agentApi.removeAgentQueueMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      index: 1,
    });
  });

  it("edits a queued message in place on the host", async () => {
    ingest({
      type: "queue_updated",
      messages: [{ id: "q-7", message: "first", waitingFor: "step" }],
    });

    await transport.updateQueuedMessage(SESSION, "q-7", "first, revised");

    expect(agentApi.updateAgentQueueMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      index: 0,
      message: "first, revised",
    });
  });

  it("removes a queued message by index", async () => {
    await transport.removeQueuedMessage(SESSION, "3");

    expect(agentApi.removeAgentQueueMessage).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      index: 3,
    });
  });

  it("clears the conversation and the joins that pointed into it", async () => {
    ingestEvent({ type: "subtask_start", id: "sub-1", kind: "task" });
    emitted = [];

    await transport.clearConversation(SESSION);

    expect(agentApi.resetAgentConversation).toHaveBeenCalled();
    expect(emitted).toContainEqual({ kind: "reset" });

    ingestEvent({ type: "text_delta", text: "x" });
    expect(loopEvents().at(-1)).not.toHaveProperty("subtaskId");
  });
});

describe("settings that apply to every open session", () => {
  beforeEach(() => {
    transport.registerSession("session-2", "workspace-2");
  });

  it("sets the model on all of them", async () => {
    await transport.setModel("gpt-5");

    expect(agentApi.setAgentModel).toHaveBeenCalledTimes(2);
    expect(agentApi.setAgentModel).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      model: "gpt-5",
    });
  });

  it.each([
    ["DEFAULT", AgentMode.Normal],
    ["ACCEPTEDITS", AgentMode.AcceptEdits],
    ["PLAN", AgentMode.PlanMode],
    ["AUTO", AgentMode.Auto],
    ["YOLO", AgentMode.Yolo],
  ])("passes %s through to the CLI", async (mode, expected) => {
    await transport.setPermissionMode(mode as never);

    expect(agentApi.setAgentMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: expected })
    );
  });

  it("falls back to the default rather than send the CLI a mode it cannot read", async () => {
    await transport.setPermissionMode("BYPASSPERMISSIONS" as never);

    expect(agentApi.setAgentMode).toHaveBeenCalledWith(
      expect.objectContaining({ mode: AgentMode.Normal })
    );
  });
});

describe("naming a session from its first message", () => {
  it("titles a session still carrying the placeholder", async () => {
    agentApi.listAgentSessions.mockResolvedValueOnce([
      { id: SESSION, label: "Untitled" },
    ]);

    await transport.sendMessage(SESSION, "fix the failing test");
    await vi.waitFor(() =>
      expect(agentApi.updateAgentSessionLabel).toHaveBeenCalledWith(
        WORKSPACE,
        SESSION,
        "fix the failing test"
      )
    );
  });

  it("never overwrites a title the user set by hand", async () => {
    agentApi.listAgentSessions.mockResolvedValueOnce([
      { id: SESSION, label: "My investigation" },
    ]);

    await transport.sendMessage(SESSION, "fix the failing test");

    expect(agentApi.updateAgentSessionLabel).not.toHaveBeenCalled();
  });

  it("sends the message even when naming the session throws", async () => {
    // A title is a nicety; it must never interfere with sending.
    agentApi.listAgentSessions.mockRejectedValueOnce(new Error("ipc gone"));

    await expect(
      transport.sendMessage(SESSION, "hello")
    ).resolves.toBeUndefined();
    expect(agentApi.sendAgentMessage).toHaveBeenCalled();
  });

  it("leaves a session with nothing usable to derive a title from", async () => {
    agentApi.listAgentSessions.mockResolvedValueOnce([
      { id: SESSION, label: "Untitled" },
    ]);

    await transport.sendMessage(SESSION, "```js\nconst a = 1\n```");

    expect(agentApi.updateAgentSessionLabel).not.toHaveBeenCalled();
  });
});

describe("the local echoes the composer relies on", () => {
  it("echoes a message with its attachments, and only when there are some", () => {
    transport.echoUserMessage(SESSION, "look at this", [
      { type: "image", data: "…" } as never,
    ]);
    transport.echoUserMessage(SESSION, "plain");

    expect(emitted).toEqual([
      {
        kind: "user_message",
        content: "look at this",
        attachments: [{ type: "image", data: "…" }],
      },
      { kind: "user_message", content: "plain" },
    ]);
  });

  it("omits an empty attachment list rather than send one", () => {
    transport.echoUserMessage(SESSION, "plain", []);

    expect(emitted).toEqual([{ kind: "user_message", content: "plain" }]);
  });

  it("retracts an echo when Stop beats the agent's reply", () => {
    transport.retractUserMessage(SESSION);

    expect(emitted).toEqual([{ kind: "retract_user_message" }]);
  });
});

describe("subscribing to the stream", () => {
  it("stops delivering once a subscriber unsubscribes", () => {
    const seen: ConversationEvent[] = [];
    const unsubscribe = transport.subscribe((_id, event) => {
      seen.push(event);
    });

    transport.reset(SESSION);
    unsubscribe();
    transport.reset(SESSION);

    expect(seen).toEqual([{ kind: "reset" }]);
  });

  it("names the session every event came from", () => {
    const sessions: string[] = [];
    transport.subscribe((id) => {
      sessions.push(id);
    });

    ingestEvent({ type: "text_delta", text: "x" });

    expect(sessions).toEqual([SESSION]);
  });
});

describe("what the chat panel owns instead", () => {
  it("refuses to create a conversation", async () => {
    await expect(transport.createConversation()).rejects.toThrow(
      "Conversation creation is owned by the chat panel"
    );
  });

  it.each([
    ["deleteConversation"],
    ["renameConversation"],
    ["loadMoreConversations"],
    ["refreshConversations"],
    ["updateQueuedMessage"],
  ])("%s is inert", async (name) => {
    const method = transport[name as keyof WorkspaceConversationTransport] as (
      this: WorkspaceConversationTransport
    ) => Promise<void>;

    await expect(method.call(transport)).resolves.toBeUndefined();
  });
});
