import type { QueueEntry } from "@abacus-ai/contract/agent-types";
/**
 * R2-T21 runtime half (spec 02 §8.5, §14.6): enqueue goes to the host queue
 * and rows come only from `queue.updated`; edits and removals carry the
 * incarnation and entry id; rejections for this incarnation are recorded,
 * older ones ignored; a pending command times out; a new generation starts
 * clean. (The rendered texts are in `kit/queue.test.tsx`.) Also R2-T10.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  memoryRelay,
  closeMemoryRelays,
} from "#renderer/test-support/chat-relay";

import * as b from "../fixtures/builders";
import type { FakeRelay } from "../fixtures/relay";
import { isBusy } from "../store/selectors";
import { ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
afterEach(() => {
  closeMemoryRelays();
  vi.useRealTimers();
  for (const session of sessions.splice(0)) session.retire();
});

/** A host queue that validates like the agent (§14.6). */
const agentQueue = () => {
  let incarnation = "inc-1";
  let entries: QueueEntry[] = [];
  let next = 0;
  const publish = (relay: FakeRelay) =>
    relay.emit(
      b.custom("queue.updated", { messages: entries, dequeued: null })
    );
  return {
    respawn(relay: FakeRelay) {
      incarnation = "inc-2";
      next = 0;
      entries = entries.map((entry) => ({ ...entry, id: `q-${++next}` }));
      relay.emitAll(b.sessionReady("inc-2"));
      publish(relay);
    },
    drain(relay: FakeRelay) {
      entries = entries.slice(1);
      publish(relay);
    },
    handler: (
      command: string,
      input: Record<string, unknown>,
      relay: FakeRelay
    ) => {
      if (command === "enqueue") {
        entries = [
          ...entries,
          {
            id: `q-${++next}`,
            message: String(input.message),
            waitingFor: "step",
          },
        ];
        publish(relay);
        return;
      }
      const entryId = String(input.entryId);
      const found = entries.find((entry) => entry.id === entryId);
      if (input.incarnation !== incarnation || found == null) {
        relay.emit(
          b.custom("queue.command_rejected", {
            incarnation,
            entryId,
            command,
            reason:
              input.incarnation !== incarnation ? "incarnation" : "not_found",
          })
        );
        publish(relay);
        return;
      }
      entries =
        command === "remove"
          ? entries.filter((entry) => entry.id !== entryId)
          : entries.map((entry) =>
              entry.id === entryId
                ? { ...entry, message: String(input.message) }
                : entry
            );
      publish(relay);
    },
  };
};

const open = async () => {
  const queue = agentQueue();
  const relay = await memoryRelay({ onQueue: queue.handler });
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("r1"),
    ...b.text("u1", "user", "go"),
  ]);
  const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
  sessions.push(session);
  await session.load();
  return { relay, session, queue };
};

describe("R2-T21 queue (runtime)", () => {
  it("enqueue shows only through queue.updated; edit/remove carry incarnation + id", async () => {
    const { relay, session } = await open();
    await session.enqueue("later");
    await vi.waitFor(() =>
      expect(session.store.state.queue.map((e) => e.message)).toEqual(["later"])
    );
    await session.updateQueued("q-1", "sooner");
    expect(relay.stats.queue.at(-1)).toMatchObject({
      command: "update",
      input: { incarnation: "inc-1", entryId: "q-1", message: "sooner" },
    });
    await vi.waitFor(() =>
      expect(session.store.state.queue[0]?.message).toBe("sooner")
    );
    expect(session.store.state.queueCommands).toEqual({});
    await session.removeQueued("q-1");
    await vi.waitFor(() => expect(session.store.state.queue).toEqual([]));
    expect(session.store.state.queueCommands).toEqual({});
  });

  it("an edit racing a drain, and one after a respawn, are rejected and change nothing", async () => {
    const { relay, session, queue } = await open();
    await session.enqueue("a");
    await vi.waitFor(() => expect(session.store.state.queue).toHaveLength(1));
    queue.drain(relay);
    await session.updateQueued("q-1", "edited");
    await vi.waitFor(() =>
      expect(session.store.state.queueCommands["q-1"]).toMatchObject({
        state: "rejected",
        reason: "not_found",
      })
    );
    session.clearQueueCommand("q-1");
    await session.enqueue("b");
    await vi.waitFor(() => expect(session.store.state.queue).toHaveLength(1));
    const staleIncarnation = session.store.state.incarnation;
    queue.respawn(relay);
    await vi.waitFor(() =>
      expect(session.store.state.incarnation).toBe("inc-2")
    );
    // A command still carrying the old incarnation (read before the respawn).
    relay.ai.queue.update({
      threadId: "t-1",
      incarnation: staleIncarnation!,
      entryId: "q-1",
      message: "x",
    });
    await vi.waitFor(() =>
      expect(relay.stats.queue.at(-1)).toMatchObject({
        command: "update",
        input: { incarnation: "inc-1" },
      })
    );
    await vi.waitFor(() =>
      expect(session.store.state.queueCommands["q-1"]).toMatchObject({
        reason: "incarnation",
      })
    );
    expect(session.store.state.queue.map((e) => e.message)).toEqual(["b"]);
  });

  it("a rejection from a previous incarnation is ignored; a silent command times out", async () => {
    const relay = await memoryRelay();
    relay.emitAll([...b.sessionReady("inc-2")]);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    relay.emit(
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "update",
        reason: "not_found",
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.store.state.queueCommands).toEqual({});
    vi.useFakeTimers();
    void session.updateQueued("q-9", "x");
    expect(session.store.state.queueCommands["q-9"]?.state).toBe("pending");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(session.store.state.queueCommands["q-9"]?.state).toBe("timeout");
  });

  it("a new generation starts with no command state", async () => {
    const { session } = await open();
    await session.updateQueued("q-7", "x");
    expect(session.store.state.queueCommands["q-7"]).toBeDefined();
    await session.reconnect();
    expect(session.store.state.queueCommands).toEqual({});
  });
});

describe("R2-T10 busy", () => {
  it("any source is busy", () => {
    expect(isBusy({ turnBusy: false, activeRun: false, outbox: 0 })).toBe(
      false
    );
    expect(isBusy({ turnBusy: true, activeRun: false, outbox: 0 })).toBe(true);
    expect(isBusy({ turnBusy: false, activeRun: true, outbox: 0 })).toBe(true);
    expect(isBusy({ turnBusy: false, activeRun: false, outbox: 1 })).toBe(true);
  });

  it("busy from submit to terminal: outbox before RUN_STARTED, then the active run", async () => {
    let started: (() => void) | null = null;
    const relay = await memoryRelay({
      onSend: (input, r) => {
        started = () =>
          r.emitAll([
            b.runStarted(input.runId),
            ...b.text(input.messages[0]!.id, "user", "x"),
          ]);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    const busy = () =>
      isBusy({
        turnBusy: false,
        activeRun: session.store.state.runs.active != null,
        outbox: session.hostStore.state.outbox.length,
      });
    expect(busy()).toBe(false);
    const submitted = session.submit("x");
    expect(busy()).toBe(true);
    await submitted;
    expect(busy()).toBe(true);
    started!();
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
    expect(busy()).toBe(true);
    relay.emit(b.runFinished(session.store.state.runs.active!.runId));
    await vi.waitFor(() => expect(busy()).toBe(false));
    // A server-initiated run and a permission wait are busy too.
    relay.emitAll([b.runStarted("srv-1", { serverInitiated: true })]);
    await vi.waitFor(() => expect(busy()).toBe(true));
  });
});
