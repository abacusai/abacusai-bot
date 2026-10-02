/**
 * The emitter and run controller, fed legacy + internal events directly
 * (the transport-bridge ports of spec §7.3 and the conformance of §7.6).
 */
import { EventSchemas } from "@ag-ui/core/schemas";
import { StreamProcessor } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { tagEvent } from "../event-meta.js";
import type { InternalAgentEvent } from "../internal-events.js";
import {
  AgentMode,
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionRequest,
} from "../protocol.js";
import { noCompat } from "./channel.js";
import { AguiEmitter } from "./emit.js";
import { isRunScoped } from "./event.js";
import { validateResponse } from "./permissions.js";
import { RunController, toTokenUsage, type TurnToken } from "./runs.js";
import { HostSink } from "./sink.js";
import type { AguiEvent } from "./wire.js";

function rig(
  incarnation = "inc-1",
  log: (line: string) => void = () => undefined
) {
  const out: AguiEvent[] = [];
  const legacy: string[] = [];
  const sink = new HostSink({ mode: "fd", write: (line) => legacy.push(line) });
  const runs: RunController = new RunController({
    threadId: "t-1",
    write: (event) => sink.writeAgui(event),
    closeOpenParts: () => emitter.closeOpenParts(),
    model: () => emitter.model(),
    onOpen: () => emitter.runOpened(),
  });
  const emitter: AguiEmitter = new AguiEmitter({
    threadId: "t-1",
    incarnation,
    runs,
    approvalTimeoutMs: () => Number.POSITIVE_INFINITY,
    now: () => 0,
    log,
  });

  sink.attach({
    emitter,
    runs,
    write: (line) => out.push(JSON.parse(line) as AguiEvent),
  });

  const agent = (event: AgentEvent): void =>
    sink.emit({ type: "event", event });
  const internal = (event: InternalAgentEvent): void => sink.internal(event);
  const desktop = (event: DesktopEvent): void => sink.emit(event);
  const open = (runId = "run-1"): TurnToken => {
    const token = runs.mint(runId);

    runs.open(token, runId, { serverInitiated: false });
    runs.setCurrent(token);

    return token;
  };
  const types = (): string[] =>
    out.map((event) =>
      event.type === "CUSTOM" ? `CUSTOM:${event.name}` : event.type
    );

  return {
    out,
    legacy,
    sink,
    runs,
    emitter,
    agent,
    internal,
    desktop,
    open,
    types,
  };
}

const tool = (id: string, name: string, input: Record<string, unknown>) => ({
  id,
  name,
  type: name,
  input,
  args: input,
});

function process(events: AguiEvent[]) {
  const processor = new StreamProcessor();

  for (const event of events) processor.processChunk(event as never);

  return processor.getMessages();
}

describe("messages", () => {
  it("brackets text and reasoning with roles, inside the run", () => {
    const r = rig();
    const token = r.open();

    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.agent({ type: "thinking_delta", content: "hmm" });
    r.agent({ type: "thinking_complete" });
    r.agent({ type: "text_delta", content: "Hello", messageId: "msg-1" });
    r.internal({ type: "message_close", key: "msg-1", stopReason: "stop" });
    r.runs.settle(token);

    expect(r.types()).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "REASONING_START",
      "REASONING_MESSAGE_START",
      "REASONING_MESSAGE_CONTENT",
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    const start = r.out[1] as unknown as { role?: string; messageId: string };

    expect(start.role).toBe("assistant");
    expect((r.out[2] as unknown as { messageId: string }).messageId).toBe(
      "s:1:think:1"
    );

    const messages = process(r.out);
    const parts = messages[0]!.parts.map((part) => part.type);

    expect(parts).toContain("thinking");
    expect(parts).toContain("text");
  });

  it("gives a colliding message id a suffix", () => {
    const r = rig();

    r.open();
    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.internal({ type: "message_close", key: "msg-1" });
    r.internal({ type: "message_open", key: "msg-2", messageId: "s:1" });

    const starts = r.out.filter(
      (e) => e.type === "TEXT_MESSAGE_START"
    ) as Array<{
      messageId: string;
    }>;

    expect(starts.map((s) => s.messageId)).toEqual(["s:1", "s:1:2"]);
  });

  it("writes nothing run-scoped outside a run, and keeps no state from it", () => {
    const r = rig();

    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.agent({ type: "text_delta", content: "late", messageId: "msg-1" });
    r.agent({ type: "status_changed", status: AgentStatus.Idle });
    const token = r.open();

    r.agent({ type: "text_delta", content: "fresh", messageId: "msg-2" });
    r.runs.settle(token);

    expect(r.types()).toEqual([
      "CUSTOM:agent.status",
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("carries steered input as a user message", () => {
    const r = rig();

    r.open();
    r.agent({ type: "user_message_steered", content: "also this" });

    expect(r.types()).toEqual([
      "RUN_STARTED",
      "CUSTOM:queue.steered",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    expect((r.out[2] as unknown as { role?: string }).role).toBe("user");
  });
});

describe("tools", () => {
  it("announces once, streams args, ends with canonical input, then one result", () => {
    const r = rig();
    const token = r.open();

    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.internal({
      type: "tool_call_start",
      toolCallId: "c1",
      toolName: "bash",
      rawName: "bash",
    });
    r.internal({
      type: "tool_call_delta",
      toolCallId: "c1",
      argumentsDelta: '{"command":',
    });
    r.internal({
      type: "tool_call_delta",
      toolCallId: "c1",
      argumentsDelta: '"ls"}',
    });
    r.internal({
      type: "tool_call_stop",
      toolCallId: "c1",
      toolName: "bash",
      arguments: '{"command":"ls"}',
    });
    r.internal({ type: "message_close", key: "msg-1", stopReason: "toolUse" });
    // The gate sees it again: nothing new.
    r.internal({
      type: "tool_call_start",
      toolCallId: "c1",
      toolName: "bash",
      rawName: "bash",
      input: { command: "ls" },
    });
    r.agent({
      type: "tool_execution_start",
      tool: tool("c1", "bash", { command: "ls" }),
    });
    r.agent({ type: "tool_output_update", toolCallId: "c1", output: "a\n" });
    r.agent({
      type: "tool_execution_complete",
      tool: tool("c1", "bash", { command: "ls" }),
      result: { id: "c1", content: "a\n", rejected: false },
    });
    r.runs.settle(token);

    const toolEvents = r.types().filter((t) => t.startsWith("TOOL_CALL"));

    expect(toolEvents).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
    ]);

    const end = r.out.find((e) => e.type === "TOOL_CALL_END") as unknown as {
      metadata: { tanstack: { input: unknown } };
    };

    expect(end.metadata.tanstack.input).toEqual({ command: "ls" });

    // A final toolUse stop reason still finishes the run as "stop" (r2-16).
    const finished = r.out.at(-1) as unknown as {
      metadata: { tanstack: { finishReason: unknown } };
    };

    expect(finished.metadata.tanstack.finishReason).toBe("stop");

    const [assistant] = process(r.out);
    const call = assistant!.parts.find(
      (p) => p.type === "tool-call"
    ) as unknown as {
      input?: unknown;
      output?: unknown;
      state: string;
    };

    expect(call.input).toEqual({ command: "ls" });
    expect(call.output).toMatchObject({
      text: "a\n",
      rejected: false,
      terminal: { output: "a\n" },
    });
  });

  it("marks a rejected result as an error with the denial outcome", () => {
    const r = rig();

    r.open();
    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.internal({
      type: "tool_call_start",
      toolCallId: "c1",
      toolName: "write",
      rawName: "write",
      input: { path: "a" },
    });
    r.internal({ type: "tool_blocked", toolCallId: "c1", cause: "rejected" });
    r.agent({
      type: "tool_execution_complete",
      tool: tool("c1", "write", { path: "a" }),
      result: {
        id: "c1",
        content: "The user rejected this tool call.",
        rejected: true,
      },
    });

    const result = r.out.find(
      (e) => e.type === "TOOL_CALL_RESULT"
    ) as unknown as {
      metadata: { tanstack: { state: string; toolResultOutcome?: string } };
    };

    expect(result.metadata.tanstack).toEqual({
      state: "output-error",
      toolResultOutcome: "denied",
    });

    const [assistant] = process(r.out);
    const resultPart = assistant!.parts.find(
      (p) => p.type === "tool-result"
    ) as unknown as {
      state: string;
      error?: string;
    };

    expect(resultPart.state).toBe("error");
    expect(resultPart.error).toBe("The user rejected this tool call.");
  });

  it("closes unresolved calls as cancelled when the run is stopped", () => {
    const r = rig();
    const token = r.open();

    r.agent({
      type: "tool_execution_start",
      tool: tool("c1", "bash", { command: "sleep 9" }),
    });
    r.runs.markCancelling(token);
    r.runs.settle(token);

    expect(r.types().slice(-2)).toEqual(["TOOL_CALL_RESULT", "RUN_FINISHED"]);
    const finished = r.out.at(-1) as unknown as { outcome: { type: string } };

    expect(finished.outcome.type).toBe("cancelled");
  });
});

describe("sub-agents", () => {
  it("tags child events, keeps colliding child ids apart, and puts results before the terminal", () => {
    const r = rig();
    const token = r.open();

    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.agent({
      type: "tool_execution_start",
      tool: tool("p1", "delegate_task", { task: "a" }),
    });
    r.agent({
      type: "tool_execution_start",
      tool: tool("p2", "delegate_task", { task: "b" }),
    });
    r.agent(
      tagEvent(
        {
          type: "subtask_start",
          id: "delegate-1",
          description: "a",
          kind: "delegate",
        },
        { parentToolCallId: "p1" }
      )
    );
    r.agent(
      tagEvent(
        {
          type: "subtask_start",
          id: "delegate-2",
          description: "b",
          kind: "delegate",
        },
        { parentToolCallId: "p2" }
      )
    );
    for (const sub of ["delegate-1", "delegate-2"]) {
      r.agent(
        tagEvent(
          {
            type: "tool_execution_start",
            tool: tool("sub-x", "read", { path: sub }),
          },
          { subagentRunId: sub }
        )
      );
    }
    r.agent(
      tagEvent(
        {
          type: "tool_execution_complete",
          tool: tool("sub-x", "read", { path: "delegate-1" }),
          result: { id: "sub-x", content: "one", rejected: false },
        },
        { subagentRunId: "delegate-1" }
      )
    );
    r.agent(
      tagEvent(
        { type: "text_delta", content: "found one" },
        { subagentRunId: "delegate-1" }
      )
    );
    r.agent({ type: "subtask_end", id: "delegate-1", status: "completed" });
    // delegate-2 never finishes: Stop.
    r.runs.markCancelling(token);
    r.runs.settle(token);

    const child = r.out.filter(
      (e) => (e as { subagentRunId?: string }).subagentRunId === "delegate-2"
    );

    expect(child.map((e) => e.type)).toEqual([
      "SUBAGENT_STARTED",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "SUBAGENT_ERROR",
    ]);
    const ids = r.out
      .filter((e) => e.type === "TOOL_CALL_START")
      .map((e) => (e as { toolCallId: string }).toolCallId);

    expect(ids).toEqual(["p1", "p2", "delegate-1:sub-x", "delegate-2:sub-x"]);

    const [assistant] = process(r.out);
    const cards = assistant!.parts.filter(
      (p) => p.type === "subagent"
    ) as Array<{
      subagent: {
        id: string;
        status: string;
        messages: Array<{ parts: Array<{ type: string }> }>;
      };
    }>;

    expect(cards.map((c) => [c.subagent.id, c.subagent.status])).toEqual([
      ["delegate-1", "finished"],
      ["delegate-2", "error"],
    ]);
    // The unfinished child's cancelled result reached its card before the error.
    const second = cards[1]!.subagent.messages.flatMap((m) =>
      m.parts.map((p) => p.type)
    );

    expect(second).toContain("tool-result");
    const first = cards[0]!.subagent.messages.flatMap((m) =>
      m.parts.map((p) => p.type)
    );

    expect(first).toEqual(
      expect.arrayContaining(["tool-call", "tool-result", "text"])
    );
  });
});

describe("runs", () => {
  it("makes the first turn-origin error the terminal, and later ones agent.error", () => {
    const r = rig();
    const token = r.open();

    r.agent(
      tagEvent(
        { type: "error", error: { message: "boom", code: "turn_failed" } },
        { origin: "turn" }
      )
    );
    r.agent(
      tagEvent(
        { type: "error", error: { message: "again" } },
        { origin: "turn" }
      )
    );
    r.agent({
      type: "error",
      error: { message: "model", code: "model_unavailable" },
    });
    r.runs.settle(token);

    expect(r.types()).toEqual([
      "RUN_STARTED",
      "CUSTOM:agent.error",
      "CUSTOM:agent.error",
      "RUN_ERROR",
    ]);
    const error = r.out.at(-1) as unknown as {
      message: string;
      code: string;
      metadata: { tanstack: { runId: string; threadId: string } };
    };

    expect(error).toMatchObject({ message: "boom", code: "turn_failed" });
    expect(error.metadata.tanstack).toMatchObject({
      runId: "run-1",
      threadId: "t-1",
    });
  });

  it("ignores a superseded token's settle", () => {
    const r = rig();
    const first = r.open("a");

    r.runs.markCancelling(first);
    r.runs.settle(first);
    const second = r.open("b");

    r.runs.settle(first);
    expect(r.runs.openRunId()).toBe("b");
    r.runs.settle(second);
    expect(r.runs.isOpen()).toBe(false);
  });

  it("refuses to open over an open run", () => {
    const r = rig();

    r.open("a");
    expect(() => r.open("b")).toThrow(/still open/);
  });

  it("maps usage with cache inside input and omits a null model", () => {
    expect(
      toTokenUsage({
        input: 10,
        output: 5,
        cacheRead: 100,
        cacheWrite: 7,
        requests: 1,
        model: null,
      })
    ).toEqual([
      {
        inputTokens: 117,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 7,
        outputTokens: 5,
        totalTokens: 122,
      },
    ]);
  });
});

describe("state", () => {
  it("snapshots on ready and patches mode, model and the first plan", () => {
    const r = rig();

    r.desktop({
      type: "ready",
      model: "fake/fake-1",
      mode: "DEFAULT",
      agentSessionId: "s",
    });
    r.agent({ type: "mode_changed", mode: AgentMode.Yolo, source: "user" });
    r.internal({
      type: "plan_changed",
      todos: [{ content: "a", status: "pending" }],
    });

    expect(r.types()).toEqual([
      "CUSTOM:session.ready",
      "STATE_SNAPSHOT",
      "STATE_DELTA",
      "STATE_DELTA",
    ]);
    const plan = r.out[3] as unknown as {
      delta: Array<{ op: string; path: string }>;
    };

    expect(plan.delta[0]).toMatchObject({ op: "add", path: "/plan" });
  });
});

describe("permissions", () => {
  const request: PermissionRequest = {
    type: "write_file",
    tool: tool("c1", "write", { path: "a" }),
    displayName: "Create file",
    filePath: "a",
    originalContent: "",
    content: "x",
    isNewFile: true,
  };

  it("publishes a descriptor bound to the owning turn, and the authoritative set", () => {
    const r = rig();
    const token = r.open();

    r.desktop({ type: "permission_needed", permissionId: "perm-1", request });

    expect(r.types().slice(-2)).toEqual([
      "CUSTOM:permission.requested",
      "CUSTOM:permission.pending",
    ]);
    const descriptor = r.emitter.pendingItems()[0]!;

    expect(descriptor.toolCallId).toBe("c1");
    expect(descriptor.metadata.abacus).toMatchObject({
      attachedBy: "gate",
      kind: "write_file",
      lineage: {
        threadId: "t-1",
        incarnation: "inc-1",
        turnSeq: token.seq,
        runId: "run-1",
      },
    });
  });

  it("validates lineage before anything is answered", () => {
    const r = rig();
    const token = r.open();

    r.desktop({ type: "permission_needed", permissionId: "perm-1", request });

    const lineage = {
      threadId: "t-1",
      incarnation: "inc-1",
      turnSeq: token.seq,
      permissionId: "perm-1",
    };
    const check = (l: object, decision: unknown) =>
      validateResponse({
        lineage: l,
        decision,
        threadId: "t-1",
        incarnation: "inc-1",
        pending: r.emitter.pendingPermissions(),
      });

    expect(check(lineage, "accept")).toBeNull();
    expect(check({ ...lineage, incarnation: "old" }, "accept")).toBe(
      "incarnation"
    );
    expect(check({ ...lineage, threadId: "other" }, "accept")).toBe("thread");
    expect(check({ ...lineage, turnSeq: 99 }, "accept")).toBe("turn");
    expect(check({ ...lineage, permissionId: "perm-9" }, "accept")).toBe(
      "not_pending"
    );
    expect(check(lineage, true)).toBe("invalid_decision");
    expect(check(lineage, { approved: true })).toBe("invalid_decision");
    expect(check(lineage, "background")).toBe("decision_not_allowed");
  });

  it("clears only the expired item", () => {
    const r = rig();

    r.open();
    r.desktop({ type: "permission_needed", permissionId: "perm-1", request });
    r.desktop({
      type: "permission_needed",
      permissionId: "perm-2",
      request: { ...request, tool: tool("c2", "write", { path: "b" }) },
    });
    r.agent({ type: "permission_cleared", permissionId: "perm-1" });

    expect(r.emitter.pendingItems().map((d) => d.id)).toEqual(["perm-2"]);
    const cleared = r.out.find(
      (e) => e.type === "CUSTOM" && e.name === "permission.cleared"
    ) as unknown as { value: { reason: string } };

    expect(cleared.value.reason).toBe("expired");
  });
});

describe("the compat line", () => {
  it("is JSON.stringify of the event and nothing else, tags included", () => {
    const r = rig();
    const event = tagEvent(
      { type: "error" as const, error: { message: "x" } },
      { origin: "turn", subagentRunId: "s" }
    );

    r.desktop({ type: "event", event });
    expect(r.legacy).toEqual([
      '{"type":"event","event":{"type":"error","error":{"message":"x"}}}\n',
    ]);
  });

  it("scopes every emitted event correctly", () => {
    const r = rig();
    const token = r.open();

    r.agent({ type: "text_delta", content: "x", messageId: "msg-1" });
    r.runs.settle(token);
    for (const event of r.out) {
      if (isRunScoped(event)) expect(event.type).not.toBe("RUN_STARTED");
    }
    expect(noCompat.mode).toBe("none");
  });
});

describe("implementation review r1", () => {
  it("scopes steer ids by incarnation, so a respawn's steer-1 never overwrites the last one", () => {
    const streams = ["inc-a", "inc-b"].map((incarnation) => {
      const r = rig(incarnation);

      r.open(`run-${incarnation}`);
      r.agent({ type: "user_message_steered", content: `from ${incarnation}` });
      r.runs.settleOpen();

      return r.out;
    });
    // Main keeps one transcript per thread across respawns.
    const users = process([...streams[0]!, ...streams[1]!]).filter(
      (message) => message.role === "user"
    );

    expect(users.map((message) => message.id)).toEqual([
      "steer-inc-a-1",
      "steer-inc-b-1",
    ]);
    expect(
      users.map((message) => (message.parts[0] as { content: string }).content)
    ).toEqual(["from inc-a", "from inc-b"]);
  });

  it("scopes an assistant message with no pi timestamp by incarnation", () => {
    const ids = ["inc-a", "inc-b"].map((incarnation) => {
      const r = rig(incarnation);

      r.desktop({
        type: "ready",
        model: "m",
        mode: "DEFAULT",
        agentSessionId: "resumed-session",
      });
      r.open();
      r.internal({ type: "message_open", key: "msg-1" });
      r.agent({ type: "text_delta", content: "hi", messageId: "msg-1" });

      return (
        r.out.find((event) => event.type === "TEXT_MESSAGE_START") as {
          messageId: string;
        }
      ).messageId;
    });

    expect(ids).toEqual([
      "resumed-session:inc-a:msg-1",
      "resumed-session:inc-b:msg-1",
    ]);
  });

  it("closes a component bracket the turn ended as unfinished, and a reported failure as failed", () => {
    const r = rig();

    r.open();
    r.agent({ type: "subtask_start", id: "component-1", kind: "component" });
    r.agent({ type: "subtask_start", id: "component-2", kind: "component" });
    // finishTurn's close-out, tagged by the session.
    r.agent(
      tagEvent(
        { type: "subtask_end", id: "component-1", status: "failed" },
        { unfinished: true }
      )
    );
    r.agent({ type: "subtask_end", id: "component-2", status: "failed" });

    expect(
      r.out
        .filter((event) => event.type === "SUBAGENT_ERROR")
        .map((event) => (event as { code?: string }).code)
    ).toEqual(["unfinished", "failed"]);
  });

  it("names the hidden turn's customType in the housekeeping usage log", () => {
    const logged: string[] = [];
    const r = rig("inc-1", (line) => logged.push(line));
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 1,
      model: "m",
    };

    r.internal({
      type: "hidden_turn",
      phase: "start",
      customType: "abacusai-bot:memory-flush",
    });
    r.agent({ type: "turn_complete", usage });
    r.internal({
      type: "hidden_turn",
      phase: "end",
      customType: "abacusai-bot:memory-flush",
    });

    expect(logged).toEqual([
      `[usage] housekeeping abacusai-bot:memory-flush ${JSON.stringify(usage)}\n`,
    ]);
    expect(r.out).toEqual([]);
  });

  it("does not let an aborted hidden turn's late closing bracket hide the next run", () => {
    const r = rig();

    r.internal({ type: "hidden_turn", phase: "start", customType: "h" });
    // Stopped mid-housekeeping; the next run opens before the bracket closes.
    r.open("next");
    r.agent({ type: "text_delta", content: "visible" });
    r.internal({ type: "hidden_turn", phase: "end", customType: "h" });
    r.agent({ type: "text_delta", content: " still" });

    expect(
      r.out
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => (event as { delta: string }).delta)
    ).toEqual(["visible", " still"]);
  });

  it("builds every emitted type as a schema-valid @ag-ui/core event", () => {
    const r = rig();
    const emitted = new Set<string>();
    const check = (events: AguiEvent[]): void => {
      for (const event of events) {
        const parsed = EventSchemas.safeParse(event);

        expect(parsed.success, JSON.stringify(event)).toBe(true);
        emitted.add(event.type);
      }
    };

    r.desktop({ type: "ready", model: "m", mode: "DEFAULT" });
    r.agent({ type: "mode_changed", mode: AgentMode.Yolo, source: "user" });
    r.open("run-a");
    r.internal({ type: "message_open", key: "msg-1", messageId: "s:1" });
    r.agent({ type: "thinking_delta", content: "hm" });
    r.agent({ type: "text_delta", content: "hi", messageId: "msg-1" });
    r.agent({
      type: "tool_execution_start",
      tool: tool("c1", "bash", { command: "ls" }),
    });
    r.agent({
      type: "tool_execution_complete",
      tool: tool("c1", "bash", { command: "ls" }),
      result: { id: "c1", content: "ok", rejected: true },
    });
    r.agent({ type: "subtask_start", id: "d-1", kind: "delegate" });
    r.agent(
      tagEvent(
        { type: "text_delta", content: "child" },
        { subagentRunId: "d-1" }
      )
    );
    r.agent({ type: "subtask_end", id: "d-1", status: "completed" });
    r.agent({ type: "subtask_start", id: "d-2", kind: "delegate" });
    r.agent({ type: "subtask_end", id: "d-2", status: "failed" });
    r.agent(
      tagEvent(
        { type: "error", error: { message: "x", code: "turn_failed" } },
        { origin: "turn" }
      )
    );
    r.runs.settleOpen();
    r.open("run-b");
    r.runs.settleOpen();
    r.open("run-c");
    r.runs.emergencyClose("agent_exit", (event) => r.out.push(event));
    check(r.out);

    expect([...emitted].sort()).toEqual(
      [
        "CUSTOM",
        "REASONING_END",
        "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END",
        "REASONING_MESSAGE_START",
        "REASONING_START",
        "RUN_ERROR",
        "RUN_FINISHED",
        "RUN_STARTED",
        "STATE_DELTA",
        "STATE_SNAPSHOT",
        "SUBAGENT_ERROR",
        "SUBAGENT_FINISHED",
        "SUBAGENT_STARTED",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
        "TEXT_MESSAGE_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "TOOL_CALL_RESULT",
        "TOOL_CALL_START",
      ].sort()
    );
  });

  it("adds nothing for an error its own run already reported as its terminal", () => {
    const r = rig();

    r.open();
    r.agent(
      tagEvent(
        { type: "error", error: { message: "thrown" } },
        { origin: "turn", attributed: true }
      )
    );

    expect(r.out.map((event) => event.type)).toEqual(["RUN_STARTED"]);
    expect(r.legacy.at(-1)).toBe(
      '{"type":"event","event":{"type":"error","error":{"message":"thrown"}}}\n'
    );
  });
});

describe("the # id reservation (desktop spec 00 C.3)", () => {
  it("encodes a provider tool id, a pi message id and a run id holding # or %, and leaves plain ids alone", () => {
    const r = rig();
    const token = r.open("run#7");

    r.internal({ type: "message_open", key: "msg-1", messageId: "s#1" });
    r.internal({
      type: "tool_call_start",
      toolCallId: "call#9%",
      toolName: "bash",
      rawName: "bash",
    });
    r.internal({
      type: "tool_call_stop",
      toolCallId: "call#9%",
      toolName: "bash",
      arguments: '{"command":"ls"}',
    });
    r.internal({ type: "message_close", key: "msg-1", stopReason: "toolUse" });
    r.agent({
      type: "tool_execution_complete",
      tool: tool("call#9%", "bash", { command: "ls" }),
      result: { id: "call#9%", content: "ok", rejected: false },
    });
    r.internal({ type: "message_open", key: "msg-2", messageId: "plain:2" });
    r.runs.settle(token);

    const ids = r.out.flatMap((event) => {
      const record = event as unknown as {
        messageId?: string;
        toolCallId?: string;
      };
      return [record.messageId, record.toolCallId].filter(
        (id): id is string => typeof id === "string"
      );
    });
    expect(ids.some((id) => id.includes("#"))).toBe(false);
    expect(ids).toContain("s%231");
    expect(ids).toContain("call%239%25");
    expect(ids).toContain("call%239%25:result");
    expect(ids).toContain("plain:2");
    // The legacy compat stream keeps the provider's own id.
    expect(r.legacy.join("\n")).toContain("call#9%");
  });
});

it("encodes a userInput message id before emitting it", () => {
  const { emitter } = rig();
  const events = emitter.userInput("r", "hello", {
    dequeued: false,
    messageId: "client#0%23",
  });
  expect(
    events.find((event) => event.type === "TEXT_MESSAGE_START")
  ).toMatchObject({ messageId: "client%230%2523" });
});
