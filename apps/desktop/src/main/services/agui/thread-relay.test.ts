/**
 * The per-thread relay (agent spec §5.3, spec 02 §14.1): driven with the
 * agent's own AG-UI goldens (`packages/agent/src/agui/__fixtures__`) and with
 * hand-built streams for what the goldens cannot show (respawns, exits,
 * clears). A fresh `StreamProcessor` fed `hydrate` + the replay must end where
 * a processor that watched live ends.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { StreamProcessor, type StreamChunk } from "@tanstack/ai";
import { describe, expect, it } from "vitest";

import { applyJsonPatch } from "./json-patch";
import {
  SeqClock,
  ThreadRelay,
  type RelayChunk,
  type RelayEvent,
  type ThreadHistory,
} from "./thread-relay";

const FIXTURES = path.join(
  import.meta.dirname,
  "../../../../../../packages/agent/src/agui/__fixtures__"
);

/** A golden, with the thread id the relay under test serves. */
const golden = (name: string): RelayEvent[] =>
  fs
    .readFileSync(path.join(FIXTURES, `${name}.agui.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RelayEvent);

const hello = (incarnation: string): RelayEvent => ({
  type: "CUSTOM",
  name: "wire.hello",
  value: { protocol: 1, wire: "agui", compat: "fd", incarnation },
});

const custom = (name: string, value: unknown): RelayEvent => ({
  type: "CUSTOM",
  name,
  value,
});

const run = (runId: string, text: string, userId = `${runId}:user`) => ({
  start: [
    { type: "RUN_STARTED", threadId: "t-1", runId },
    { type: "TEXT_MESSAGE_START", messageId: userId, role: "user" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: userId, delta: text },
    { type: "TEXT_MESSAGE_END", messageId: userId },
  ] as RelayEvent[],
  reply: (messageId: string, delta: string): RelayEvent[] => [
    { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId, delta },
    { type: "TEXT_MESSAGE_END", messageId },
  ],
  finished: {
    type: "RUN_FINISHED",
    threadId: "t-1",
    runId,
    outcome: { type: "success" },
  } as RelayEvent,
});

interface Harness {
  relay: ThreadRelay;
  persisted: ThreadHistory[];
  removed: number;
  clock: SeqClock;
}

const make = (
  history: ThreadHistory = { messages: [], runs: [] },
  clock = new SeqClock()
): Harness => {
  const state: Harness = {
    relay: null as unknown as ThreadRelay,
    persisted: [],
    removed: 0,
    clock,
  };
  state.relay = new ThreadRelay({
    threadId: "t-1",
    clock,
    epoch: "epoch-1",
    history,
    persist: (next) => state.persisted.push(structuredClone(next)),
    remove: () => {
      state.removed += 1;
    },
    log: () => undefined,
  });
  return state;
};

const feed = (relay: ThreadRelay, events: RelayEvent[], runtime?: object) =>
  events.map((event) => relay.ingest(event, runtime ?? null));

const processorFrom = (
  messages: ReturnType<ThreadRelay["checkpoint"]>["messages"],
  chunks: readonly RelayChunk[]
) => {
  const processor = new StreamProcessor({ initialMessages: messages });
  for (const chunk of chunks) processor.processChunk(chunk.event);
  return processor.getMessages();
};

/** Messages without the processor's wall-clock `createdAt`. */
const timeless = (messages: unknown): unknown =>
  JSON.parse(
    JSON.stringify(messages, (key, value: unknown) =>
      key === "createdAt" ? undefined : value
    )
  );

const textOf = (messages: ReturnType<StreamProcessor["getMessages"]>) =>
  messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { content: string }).content)
      .join(""),
  }));

describe("a thread's relay", () => {
  it("persists the processor's transcript and the run's outcome at each terminal", () => {
    const { relay, persisted } = make();
    const events = golden("permission-accept");

    feed(relay, [hello("inc-1"), ...events]);

    expect(persisted).toHaveLength(1);
    const [saved] = persisted;
    expect(saved!.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(saved!.runs).toEqual([
      expect.objectContaining({
        runId: "srv-<1>",
        kind: "success",
        steps: 1,
        afterMessageId: "<MSG_3>",
        usage: expect.objectContaining({ totalTokens: 0 }),
      }),
    ]);
    // The same messages a processor that watched live holds.
    const live = new StreamProcessor();
    for (const event of events)
      live.processChunk(event as unknown as StreamChunk);
    expect(timeless(saved!.messages)).toEqual(timeless(live.getMessages()));
  });

  it("keeps the session-scoped state hydrate serves", () => {
    const { relay } = make();
    feed(relay, [hello("inc-1"), ...golden("todo-plan")]);

    const { snapshot } = relay.checkpoint();
    expect(snapshot.incarnation).toBe("inc-1");
    expect(snapshot.agent).toMatchObject({ mode: expect.any(String) });
    expect(snapshot.agent?.plan).toBeDefined();
    expect(snapshot.activity.status).toBe("idle");
    expect(snapshot.skills).toEqual([]);
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.epoch).toBe("epoch-1");
  });

  it("serves the pending permission of the live incarnation only", () => {
    const { relay } = make();
    const events = golden("permission-accept");
    const upToAsk = events.findIndex(
      (event) => event.type === "CUSTOM" && event.name === "permission.pending"
    );
    feed(relay, [hello("inc-1"), ...events.slice(0, upToAsk + 1)]);

    expect(relay.checkpoint().snapshot.permissions).toHaveLength(1);
    expect(relay.checkpoint().snapshot.activeRun).toMatchObject({
      runId: "srv-<1>",
      serverInitiated: true,
    });

    // A new process: the old descriptors mean nothing to it.
    relay.ingest(hello("inc-2"), {});
    expect(relay.checkpoint().snapshot.permissions).toEqual([]);
  });

  it("checkpoint + joinRun rebuild exactly what a live client holds, mid-run", () => {
    const { relay } = make();
    const events = golden("delegate-colliding-ids");
    const cut = Math.floor(events.length * 0.6);
    feed(relay, [hello("inc-1"), ...events.slice(0, cut)]);

    // One relay turn: the checkpoint and the join.
    const { messages, activeRun } = relay.checkpoint();
    expect(activeRun).not.toBeNull();
    const live: RelayChunk[] = [];
    const joined = relay.joinRun(activeRun!.runId, (chunk) => live.push(chunk));
    expect(joined).not.toBeNull();
    expect((joined!.replay[0]!.event as unknown as RelayEvent).type).toBe(
      "RUN_STARTED"
    );

    feed(relay, events.slice(cut));
    joined!.unsubscribe();

    const watchedLive = new StreamProcessor();
    for (const event of events)
      watchedLive.processChunk(event as unknown as StreamChunk);
    expect(
      timeless(processorFrom(messages, [...joined!.replay, ...live]))
    ).toEqual(timeless(watchedLive.getMessages()));
  });

  it("resumes after a seq from the ring, and says resync for a point it no longer holds", () => {
    const clock = new SeqClock();
    clock.next(); // another thread's event
    const { relay } = make(undefined, clock);
    const chunks = feed(relay, [hello("inc-1"), ...golden("plain-text")]);
    const third = chunks[2]!;

    const resumed = relay.subscribe(third.seq, () => undefined);
    expect((resumed.replay as RelayChunk[]).map((chunk) => chunk.seq)).toEqual(
      chunks.slice(3).map((chunk) => chunk!.seq)
    );
    resumed.unsubscribe();

    // Older than the thread's floor, or newer than anything issued.
    expect(relay.subscribe(0, () => undefined).replay).toBe("resync");
    expect(relay.subscribe(clock.current + 5, () => undefined).replay).toBe(
      "resync"
    );
    expect(relay.subscribe(clock.current, () => undefined).replay).toEqual([]);
  });

  it("does not echo a user message the transcript already holds (a retry after a respawn)", () => {
    const { relay, persisted } = make();
    const first = run("run-1", "question", "u-1");
    feed(relay, [hello("inc-1"), ...first.start]);
    relay.ingest({
      type: "RUN_ERROR",
      message: "failed",
      code: "turn_failed",
      metadata: { tanstack: { threadId: "t-1", runId: "run-1" } },
    });

    // The new process does not know it echoed u-1 already.
    const retry = run("run-2", "question", "u-1");
    const dropped = feed(relay, [hello("inc-2"), ...retry.start], {});
    feed(relay, [...retry.reply("a-1", "answer"), retry.finished]);

    expect(dropped.slice(2).every((chunk) => chunk == null)).toBe(true);
    const saved = persisted.at(-1)!;
    expect(textOf(saved.messages).filter((m) => m.role === "user")).toEqual([
      { id: "u-1", role: "user", text: "question" },
    ]);
    expect(saved.runs.map((outcome) => outcome.kind)).toEqual([
      "error",
      "success",
    ]);
  });

  it("closes a run whose process exited, and drops that run's late stream (first terminal wins)", () => {
    const { relay, persisted } = make();
    const runtime = {};
    const first = run("run-1", "hi");
    feed(
      relay,
      [hello("inc-1"), ...first.start, ...first.reply("a", "par")],
      runtime
    );
    relay.ingest(
      custom("permission.pending", {
        incarnation: "inc-1",
        items: [
          {
            id: "perm-1",
            metadata: { abacus: { lineage: { incarnation: "inc-1" } } },
          },
        ],
      }),
      runtime
    );
    relay.ingest(
      custom("queue.updated", {
        messages: [{ id: "q-1", message: "next", waitingFor: "turn" }],
        dequeued: null,
      }),
      runtime
    );

    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));
    relay.runtimeExited(
      runtime,
      "agent_crashed",
      "The agent stopped unexpectedly (SIGKILL)."
    );

    const names = seen.map((chunk) => {
      const event = chunk.event as unknown as RelayEvent;
      return event.type === "CUSTOM" ? String(event.name) : event.type;
    });
    expect(names).toEqual(["RUN_ERROR", "permission.pending", "queue.updated"]);
    expect(seen[0]!.event).toMatchObject({
      code: "agent_crashed",
      metadata: { tanstack: { runId: "run-1" } },
    });
    expect(persisted.at(-1)!.runs.at(-1)).toMatchObject({
      runId: "run-1",
      kind: "error",
      error: { code: "agent_crashed" },
    });
    const snapshot = relay.checkpoint().snapshot;
    expect(snapshot.activeRun).toBeNull();
    expect(snapshot.permissions).toEqual([]);
    expect(snapshot.queue).toEqual([]);

    // Main's inactivity terminal, then the agent's own late cancel.
    const second = run("run-2", "again");
    feed(relay, [hello("inc-2"), ...second.start], {});
    expect(
      relay.failActiveRun("inactivity_timeout", "timed out")
    ).not.toBeNull();
    expect(relay.ingest(second.reply("late", "tail")[0]!)).toBeNull();
    expect(
      relay.ingest({ ...second.finished, outcome: { type: "cancelled" } })
    ).toBeNull();
    expect(relay.checkpoint().snapshot.runOutcomes.at(-1)).toMatchObject({
      runId: "run-2",
      kind: "error",
      error: { code: "inactivity_timeout" },
    });
  });

  it("ignores an exit of a runtime that is no longer the thread's", () => {
    const { relay } = make();
    const first = run("run-1", "hi");
    feed(relay, [hello("inc-2"), ...first.start], { name: "new" });
    relay.runtimeExited({ name: "old" }, "agent_exit", "gone");
    expect(relay.activeRunId).toBe("run-1");
  });

  it("drops run-scoped events outside a run", () => {
    const { relay } = make();
    expect(
      relay.ingest({ type: "TEXT_MESSAGE_CONTENT", messageId: "x", delta: "y" })
    ).toBeNull();
    expect(
      relay.ingest(custom("tool.output", { toolCallId: "c", output: "o" }))
    ).toBeNull();
    expect(
      relay.ingest(custom("agent.status", { status: "idle" }))
    ).not.toBeNull();
  });

  it("a clear drops history at once; a run from before it persists nothing", () => {
    const { relay, persisted, removed } = make({
      messages: [
        { id: "old", role: "user", parts: [{ type: "text", content: "old" }] },
      ],
      runs: [],
      migratedFrom: { updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(removed).toBe(0);
    const first = run("run-1", "hi");
    feed(relay, [hello("inc-1"), ...first.start]);

    relay.clearHistory();
    expect(relay.checkpoint().messages).toEqual([]);
    feed(relay, [...first.reply("a", "reply"), first.finished]);
    expect(persisted).toEqual([]);
    expect(relay.checkpoint().messages).toEqual([]);

    // The next run starts a new history, without the old migration marker.
    const second = run("run-2", "fresh");
    feed(relay, [...second.start, ...second.reply("b", "ok"), second.finished]);
    expect(persisted.at(-1)!.migratedFrom).toBeUndefined();
    expect(textOf(persisted.at(-1)!.messages).map((m) => m.text)).toEqual([
      "fresh",
      "ok",
    ]);
  });

  it("session.cleared from the agent clears and removes the thread file", () => {
    const harness = make();
    const events = golden("reset-conversation");
    const cleared = events.findIndex(
      (event) => event.type === "CUSTOM" && event.name === "session.cleared"
    );
    feed(harness.relay, [hello("inc-1"), ...events.slice(0, cleared + 1)]);
    expect(harness.removed).toBe(1);
    expect(harness.relay.checkpoint().messages).toEqual([]);
    expect(harness.relay.checkpoint().snapshot.runOutcomes).toEqual([]);

    // The conversation after the reset is all the file then holds.
    feed(harness.relay, events.slice(cleared + 1));
    const saved = harness.persisted.at(-1)!;
    expect(saved.runs.map((outcome) => outcome.runId)).toEqual(["srv-<3>"]);
    expect(saved.messages.every((m) => m.id !== "srv-<1>:user")).toBe(true);
  });

  it("answers a refused queue command on the stream, then the queue", () => {
    const { relay } = make();
    relay.ingest(hello("inc-1"));
    relay.ingest(
      custom("queue.updated", {
        messages: [
          { id: "q-1", message: "a", waitingFor: "turn" },
          { id: "q-2", message: "b", hidden: true, waitingFor: "turn" },
        ],
        dequeued: null,
      })
    );
    expect(relay.checkpoint().snapshot.queue.map((entry) => entry.id)).toEqual([
      "q-1",
    ]);
    const seen: RelayEvent[] = [];
    relay.subscribe(null, (chunk) =>
      seen.push(chunk.event as unknown as RelayEvent)
    );
    relay.rejectQueueCommand("q-9", "remove", "not_found");
    expect(seen).toMatchObject([
      {
        name: "queue.command_rejected",
        value: {
          incarnation: "inc-1",
          entryId: "q-9",
          command: "remove",
          reason: "not_found",
        },
      },
      { name: "queue.updated" },
    ]);
  });

  it("dedupes notices by notificationKey and keeps the latest agent state across deltas", () => {
    const { relay } = make();
    relay.ingest(hello("inc-1"));
    relay.ingest({
      type: "STATE_SNAPSHOT",
      snapshot: {
        mode: "DEFAULT",
        modeSource: "startup",
        model: "m",
        incarnation: "inc-1",
      },
    });
    relay.ingest({
      type: "STATE_DELTA",
      delta: [
        { op: "replace", path: "/mode", value: "PLAN" },
        {
          op: "add",
          path: "/plan",
          value: [{ content: "x", status: "pending" }],
        },
      ],
    });
    relay.ingest(
      custom("agent.notification", {
        message: "a",
        severity: "info",
        notificationKey: "k",
      })
    );
    relay.ingest(
      custom("agent.notification", {
        message: "b",
        severity: "info",
        notificationKey: "k",
      })
    );
    relay.ingest(custom("agent.error", { message: "c" }));

    const { snapshot } = relay.checkpoint();
    expect(snapshot.agent).toMatchObject({
      mode: "PLAN",
      plan: [{ content: "x" }],
    });
    expect(snapshot.notices.map((notice) => notice.value.message)).toEqual([
      "b",
      "c",
    ]);
  });
});

describe("applyJsonPatch", () => {
  it("applies the subset the agent emits and refuses the rest", () => {
    const base = { mode: "A", model: "m" };
    expect(
      applyJsonPatch(base, [
        { op: "replace", path: "/mode", value: "B" },
        { op: "add", path: "/plan", value: [] },
        { op: "add", path: "/plan/-", value: 1 },
      ])
    ).toEqual({ mode: "B", model: "m", plan: [1] });
    expect(base).toEqual({ mode: "A", model: "m" });
    expect(
      applyJsonPatch(base, [{ op: "replace", path: "/nope", value: 1 }])
    ).toBeNull();
    expect(applyJsonPatch(base, [{ op: "move", path: "/mode" }])).toBeNull();
    expect(
      applyJsonPatch({ "a/b": 1 }, [{ op: "remove", path: "/a~1b" }])
    ).toEqual({});
  });
});
