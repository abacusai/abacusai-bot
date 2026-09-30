import { ORPCError } from "@orpc/client";
import { describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { golden } from "../fixtures/goldens";
import { FakeRelay } from "../fixtures/relay";
import { createDispatcher } from "./dispatcher";
import { ThreadSession } from "./session";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("admission lifecycle regressions", () => {
  it("a recovery preserves an in-flight admission, retirement prevents reconciliation", async () => {
    const gate = deferred<{ runId: string; status: "started" }>();
    const relay = new FakeRelay({ onSend: () => gate.promise });
    relay.emitAll(b.sessionReady());
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: relay.threadId,
      reconcileDelaysMs: [5, 5],
    });
    try {
      await session.load();
      const admission = session.submit("pending");
      await vi.waitFor(() => expect(relay.stats.send).toHaveLength(1));
      await session.reconnect();
      gate.resolve({ runId: relay.stats.send[0]!.runId, status: "started" });
      await expect(admission).resolves.toEqual({ kind: "started" });
      expect(session.hostStore.state.outbox[0]?.state).toBe("accepted");
    } finally {
      session.retire();
    }

    const late = deferred<{ runId: string; status: "started" }>();
    const secondRelay = new FakeRelay({ onSend: () => late.promise });
    secondRelay.emitAll(b.sessionReady());
    const second = new ThreadSession({
      ai: secondRelay.ai,
      threadId: secondRelay.threadId,
      reconcileDelaysMs: [5, 5],
    });
    await second.load();
    const pending = second.submit("late");
    await vi.waitFor(() => expect(secondRelay.stats.send).toHaveLength(1));
    second.retire();
    late.reject(new ORPCError("TIMEOUT"));
    await expect(pending).resolves.toEqual({ kind: "stale" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(secondRelay.stats.send).toHaveLength(1);
  });

  it("retry reserves one new run in the outbox and reconciles its lost response", async () => {
    const relay = new FakeRelay({ events: golden("plain-text") });
    relay.faults.send = () => new ORPCError("TIMEOUT");
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: relay.threadId,
      reconcileDelaysMs: [5, 5],
    });
    try {
      await session.load();
      const last = session.hostStore.state.messages.findLast(
        (message) => message.role === "user"
      )!;
      await expect(session.retry()).resolves.toEqual({ kind: "unconfirmed" });
      expect(session.hostStore.state.outbox[0]?.id).toBe(last.id);
      expect(session.stopTarget()).toBe(
        session.hostStore.state.outbox[0]?.runId
      );
      await expect(session.retry()).resolves.toEqual({
        kind: "rejected",
        reason: "busy",
      });
      await vi.waitFor(() => expect(relay.stats.send).toHaveLength(3));
      expect(new Set(relay.stats.send.map((input) => input.runId)).size).toBe(
        1
      );
      expect(session.hostStore.state.outbox[0]?.state).toBe("failed");
    } finally {
      session.retire();
    }
  });

  it("repeated answered joins below the checkpoint exhaust the recovery budget", async () => {
    const events = golden("plain-text");
    const end = events.findIndex((item) => item.event.type === "RUN_FINISHED");
    const relay = new FakeRelay({ events: events.slice(0, end) });
    relay.faults.joinRun = (_call, delivered) =>
      delivered > 0 ? new Error("broken") : null;
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: relay.threadId,
      recoveryDelaysMs: [0, 10, 20],
      readyCapMs: 200,
    });
    try {
      void session.load().catch(() => {});
      await vi.waitFor(() =>
        expect(session.hostStore.state.connection).toBe("error")
      );
      expect(relay.stats.joinRun).toBe(4);
    } finally {
      session.retire();
    }
  });

  it("hook failures are reported and the following event is consumed", async () => {
    const failures: unknown[] = [];
    const dispatcher = createDispatcher({
      pre: () => {
        throw new Error("pre");
      },
      post: () => {
        throw new Error("post");
      },
      error: (error) => failures.push(error),
    });
    const stream = dispatcher.stream();
    dispatcher.push({ seq: 1, event: b.runStarted("a") });
    dispatcher.push({ seq: 2, event: b.runStarted("b") });
    expect((await stream.next()).value).toMatchObject({ runId: "a" });
    expect((await stream.next()).value).toMatchObject({ runId: "b" });
    expect(failures).toHaveLength(3);
    dispatcher.close();
    await stream.next();
    expect(dispatcher.pending).toBe(0);
  });
});

describe("r2 generation regressions", () => {
  it("keeps RUN_ERROR and following events in the installed client's stream", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const consumed: number[] = [];
    const session = new ThreadSession({
      ai: relay.ai,
      threadId: relay.threadId,
      onConsumed: (seq) => consumed.push(seq),
    });
    try {
      await session.load();
      relay.emitAll([
        b.runStarted("failed"),
        ...b.text("answer", "assistant", "partial"),
      ]);
      await vi.waitFor(() =>
        expect(session.store.state.runs.active?.runId).toBe("failed")
      );
      await session.cancel();
      relay.emitAll([
        b.runError("failed", { message: "ordinary failure" }),
        b.custom("agent.status", { status: "idle" }),
      ]);
      await vi.waitFor(() => expect(consumed.at(-1)).toBe(relay.lastSeq));
      expect(session.gen).toBe(1);
      expect(session.store.state.runs.outcomes).toHaveLength(1);
      expect(session.store.state.runs.outcomes[0]).toMatchObject({
        runId: "failed",
        live: true,
      });
      expect(session.hostStore.state.cancelling).toBe(false);
    } finally {
      session.retire();
    }
  });

  it.each(["success", "failure"])(
    "late hydration %s cannot revive a capped generation",
    async (settlement) => {
      const relay = new FakeRelay();
      const gate = deferred<void>();
      relay.faults.hydrate = () => gate.promise;
      const session = new ThreadSession({
        ai: relay.ai,
        threadId: relay.threadId,
        readyCapMs: 5,
      });
      try {
        await expect(session.load()).rejects.toThrow("hydration timed out");
        if (settlement === "success") gate.resolve();
        else gate.reject(new Error("late"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(session.ready).toBe(false);
        expect(session.hostStore.state.phase).toBe("error");
        expect(session.hostStore.state.error).toMatchObject({
          message: "chat: hydration timed out",
        });
        expect(relay.stats.subscribe).toBe(0);
      } finally {
        session.retire();
      }
    }
  );
});
