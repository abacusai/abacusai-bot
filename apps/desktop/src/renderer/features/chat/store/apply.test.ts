/**
 * R2-T8 (spec 02 §4.2): the event → store table row by row, the snapshot's
 * session slices with no further events, run-scoped slices rebuilt from an
 * inclusive replay (live bash output, tool.display before the result),
 * disjoint display patches merged, permission.pending authoritative, an
 * incarnation change dropping old descriptors, session.cleared resetting.
 */
import type { StreamChunk } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "../runtime/session";
import { applyEvent, recordTerminal } from "./apply";
import {
  emptyThreadState,
  toolKey,
  type ThreadStoreState,
} from "./thread-store";

const fold = (
  events: StreamChunk[],
  start: ThreadStoreState = emptyThreadState(0)
) =>
  events.reduce(
    (state, event, index) => applyEvent(state, index + 1, event),
    start
  );

const sessions: ThreadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

describe("R2-T8 applyEvent", () => {
  it("runs: RUN_STARTED sets active; the terminal record is post-apply", () => {
    const started = fold([
      b.runStarted("r1", { serverInitiated: true, timestamp: 1000 }),
    ]);
    expect(started.runs.active).toEqual({
      runId: "r1",
      startedAt: 1000,
      serverInitiated: true,
    });
    const finished = recordTerminal(
      started,
      b.runFinished("r1", "cancelled"),
      [{ id: "u", role: "user", parts: [{ type: "text", content: "x" }] }],
      5000
    );
    expect(finished.runs.active).toBeNull();
    expect(finished.runs.outcomes[0]).toMatchObject({
      runId: "r1",
      kind: "cancelled",
      startedAt: 1000,
      steps: 0,
      afterMessageId: "u",
    });
    const failed = recordTerminal(
      started,
      b.runError("r1", { message: "Boom", code: "turn_failed" }),
      [],
      6000
    );
    expect(failed.runs.outcomes[0]).toMatchObject({
      kind: "error",
      error: { message: "Boom", code: "turn_failed" },
    });
  });

  it("tool.output replaces, tool.display merges disjoint patches, the result drops live output", () => {
    const key = toolKey(undefined, "c1");
    const child = toolKey("sub-1", "c2");
    const state = fold([
      b.runStarted("r1"),
      b.custom("tool.output", { toolCallId: "c1", output: "a" }),
      b.custom("tool.output", { toolCallId: "c1", output: "ab" }),
      b.custom(
        "tool.output",
        { toolCallId: "c2", output: "child" },
        { subagentRunId: "sub-1" }
      ),
      b.custom("tool.display", {
        toolCallId: "c1",
        data: { originalContent: "x" },
      }),
      b.custom("tool.display", { toolCallId: "c1", data: { newContent: "y" } }),
    ]);
    expect(state.tools.output[key]).toBe("ab");
    expect(state.tools.output[child]).toBe("child");
    expect(state.tools.display[key]).toEqual({
      originalContent: "x",
      newContent: "y",
    });
    const after = applyEvent(state, 99, b.toolResult("c1", { text: "done" }));
    expect(after.tools.output[key]).toBeUndefined();
  });

  it("permission.pending is authoritative; responses and incarnations", () => {
    const d1 = b.descriptor({ type: "run_terminal", command: "ls" } as never, {
      id: "p1",
    });
    const d2 = b.descriptor({ type: "run_terminal", command: "pwd" } as never, {
      id: "p2",
    });
    let state = fold([...b.permissionEvents([d1, d2], d2)]);
    expect(state.permissions.items.map((d) => d.id)).toEqual(["p1", "p2"]);
    state = {
      ...state,
      permissions: {
        ...state.permissions,
        answering: { p1: { state: "sending", decision: "accept", since: 1 } },
      },
    };
    state = applyEvent(
      state,
      10,
      b.custom("permission.response_rejected", {
        lineage: d1.metadata.abacus.lineage,
        reason: "not_pending",
      })
    );
    expect(state.permissions.answering.p1).toMatchObject({
      state: "error",
      message: "notPending",
    });
    state = applyEvent(
      state,
      11,
      b.custom("permission.pending", { incarnation: "inc-1", items: [d2] })
    );
    expect(state.permissions.items.map((d) => d.id)).toEqual(["p2"]);
    expect(state.permissions.answering.p1).toBeUndefined();
    state = applyEvent(
      { ...state, incarnation: "inc-1" },
      12,
      b.custom("session.ready", { incarnation: "inc-2" })
    );
    expect(state.incarnation).toBe("inc-2");
    expect(state.permissions.items).toEqual([]);
  });

  it("queue, commands, activity, notices, skills, agent state", () => {
    let state: ThreadStoreState = {
      ...emptyThreadState(0),
      incarnation: "inc-1",
    };
    state = applyEvent(
      state,
      1,
      b.custom("queue.updated", {
        messages: [
          { id: "q-1", message: "a", waitingFor: "step" },
          { id: "q-2", message: "h", waitingFor: "turn", hidden: true },
        ],
        dequeued: null,
      })
    );
    expect(state.queue.map((e) => e.id)).toEqual(["q-1"]);
    state = {
      ...state,
      queueCommands: {
        "q-1": { state: "pending", command: "update", text: "b", since: 1 },
      },
    };
    state = applyEvent(
      state,
      2,
      b.custom("queue.updated", {
        messages: [{ id: "q-1", message: "b", waitingFor: "step" }],
        dequeued: null,
      })
    );
    expect(state.queueCommands).toEqual({});
    state = applyEvent(
      state,
      3,
      b.custom("queue.command_rejected", {
        incarnation: "inc-0",
        entryId: "q-1",
        command: "remove",
        reason: "not_found",
      })
    );
    expect(state.queueCommands).toEqual({});
    state = applyEvent(
      state,
      4,
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "remove",
        reason: "not_found",
      })
    );
    expect(state.queueCommands["q-1"]).toMatchObject({
      state: "rejected",
      reason: "not_found",
    });
    state = applyEvent(
      state,
      5,
      b.custom("agent.status", { status: "streaming" })
    );
    state = applyEvent(
      state,
      6,
      b.custom("agent.heartbeat", { runningTools: 2 })
    );
    expect(state.activity).toMatchObject({
      status: "streaming",
      runningTools: 2,
    });
    state = applyEvent(
      state,
      7,
      b.custom("agent.retry", {
        attempt: 2,
        maxAttempts: 5,
        delayMs: 100,
        isNetworkError: true,
      })
    );
    expect(state.activity.retry?.attempt).toBe(2);
    state = applyEvent(state, 8, b.textStart("m"));
    expect(state.activity.retry).toBeNull();
    state = applyEvent(
      state,
      9,
      b.custom("agent.notification", {
        severity: "info",
        message: "one",
        notificationKey: "k",
      })
    );
    state = applyEvent(
      state,
      10,
      b.custom("agent.notification", {
        severity: "info",
        message: "two",
        notificationKey: "k",
      })
    );
    expect(state.notices.map((n) => n.value.message)).toEqual(["two"]);
    state = applyEvent(
      state,
      11,
      b.custom("skills.loaded", {
        skills: [{ id: "s", name: "s", description: "", location: "" }],
      })
    );
    expect(state.skills).toHaveLength(1);
    state = applyEvent(
      state,
      12,
      b.stateSnapshot({
        mode: "DEFAULT",
        modeSource: "startup",
        model: "m",
        incarnation: "inc-1",
      })
    );
    state = applyEvent(state, 13, {
      type: "STATE_DELTA",
      delta: [{ op: "replace", path: "/mode", value: "PLAN" }],
    } as never);
    expect(state.agent?.mode).toBe("PLAN");
  });

  it("session slices skip seq ≤ cursor; run slices do not", () => {
    const start = emptyThreadState(10);
    const state = applyEvent(
      applyEvent(start, 5, b.custom("agent.status", { status: "streaming" })),
      6,
      b.custom("tool.output", { toolCallId: "c", output: "x" })
    );
    expect(state.activity.status).toBeNull();
    expect(state.tools.output[toolKey(undefined, "c")]).toBe("x");
  });
});

describe("R2-T8 through the session", () => {
  it("hydrates session slices with no further events", async () => {
    const d = b.descriptor({ type: "run_terminal", command: "ls" } as never, {
      id: "p1",
      toolCallId: "c1",
    });
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("skills.loaded", {
        skills: [{ id: "s", name: "s", description: "", location: "" }],
      }),
      b.custom("queue.updated", {
        messages: [{ id: "q-1", message: "later", waitingFor: "turn" }],
        dequeued: null,
      }),
      b.custom("agent.notification", {
        severity: "warning",
        message: "Heads up",
      }),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go"),
      b.custom("agent.status", { status: "executing-tool" }),
      b.custom("agent.heartbeat", { runningTools: 1 }),
      ...b.permissionEvents([d], d),
    ]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    const state = session.store.state;
    expect(state.permissions.items.map((i) => i.id)).toEqual(["p1"]);
    expect(state.queue.map((q) => q.id)).toEqual(["q-1"]);
    expect(state.agent?.mode).toBe("DEFAULT");
    expect(state.skills).toHaveLength(1);
    expect(state.activity).toMatchObject({
      status: "executing-tool",
      runningTools: 1,
    });
    expect(state.notices).toHaveLength(1);
    expect(state.incarnation).toBe("inc-1");
  });

  it("a reload during live bash output restores the output; a reload after tool.display restores the diff", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go"),
      b.textStart("a1"),
      ...b.toolCall("c1", "bash", "a1", { command: "npm test" }),
      b.custom("tool.output", { toolCallId: "c1", output: "PASS 1\n" }),
      b.custom("tool.output", { toolCallId: "c1", output: "PASS 1\nPASS 2\n" }),
      ...b.toolCall("c2", "edit", "a1", { path: "a.ts" }),
      b.custom("tool.display", {
        toolCallId: "c2",
        data: { originalContent: "a" },
      }),
      b.custom("tool.display", {
        toolCallId: "c2",
        data: { newContent: "b", additions: 1, deletions: 1 },
      }),
    ]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    const state = session.store.state;
    expect(state.tools.output[toolKey(undefined, "c1")]).toBe(
      "PASS 1\nPASS 2\n"
    );
    expect(state.tools.display[toolKey(undefined, "c2")]).toEqual({
      originalContent: "a",
      newContent: "b",
      additions: 1,
      deletions: 1,
    });
  });

  it("session.cleared resets to a new generation", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go"),
      b.runFinished("r1"),
    ]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    relay.emit(b.custom("session.cleared", {}));
    await vi.waitFor(() => expect(session.rev).toBe(1));
    await session.load();
    expect(session.hostStore.state.messages).toEqual([]);
    expect(session.store.state.runs.outcomes).toEqual([]);
  });
});
