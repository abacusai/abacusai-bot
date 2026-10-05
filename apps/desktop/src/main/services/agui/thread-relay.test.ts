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
import { restoreInboundChunk } from "@tanstack/ai/client";
import { describe, expect, it } from "vitest";

import { applyJsonPatch } from "./json-patch";
import {
  FINISHED_LOG_TTL_MS,
  FINISHED_LOGS_KEPT,
  RING_EVENTS,
  SeqClock,
  terminalRunId,
  ThreadRelay,
  type RelayChunk,
  type RelayEvent,
  type ThreadHistory,
  type ThreadRelayOptions,
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
  clock = new SeqClock(),
  extra: Partial<ThreadRelayOptions> = {}
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
    ...extra,
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

  it("evicts completed runs from the ring (resync), while the transcript still holds them", () => {
    const { relay } = make();
    relay.ingest(hello("inc-1"));
    const first = run("run-1", "first");
    const [start] = feed(relay, first.start);
    feed(relay, [...first.reply("a-1", "one"), first.finished]);
    for (let i = 0; i < RING_EVENTS; i += 1)
      relay.ingest(custom("agent.heartbeat", { runningTools: i % 3 }));

    expect(relay.subscribe(start!.seq, () => undefined).replay).toBe("resync");
    const { messages, snapshot } = relay.checkpoint();
    expect(textOf(messages).map((m) => m.text)).toEqual(["first", "one"]);
    expect(snapshot.runOutcomes.map((o) => o.runId)).toEqual(["run-1"]);
    // Its log is still joinable while it is among the last finished runs.
    expect(relay.joinRun("run-1", () => undefined)?.ended).toBe(true);
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

  it("a clear by main drops history at once, says session.cleared on the stream; a run from before it persists nothing", () => {
    const harness = make({
      messages: [
        { id: "old", role: "user", parts: [{ type: "text", content: "old" }] },
      ],
      runs: [],
      migratedFrom: { updatedAt: "2026-01-01T00:00:00.000Z" },
    });
    const { relay, persisted } = harness;
    const first = run("run-1", "hi");
    feed(relay, [hello("inc-1"), ...first.start]);
    const seen: RelayEvent[] = [];
    relay.subscribe(null, (chunk) =>
      seen.push(chunk.event as unknown as RelayEvent)
    );

    relay.clearByMain();
    // The open run is retired first (cancelled), then every open window
    // hears the clear (the kit bumps `rev`), and the file goes.
    expect(seen).toMatchObject([
      { type: "RUN_FINISHED", runId: "run-1", outcome: { type: "cancelled" } },
      { type: "CUSTOM", name: "session.cleared" },
    ]);
    expect(harness.removed).toBe(1);
    expect(relay.checkpoint().messages).toEqual([]);
    expect(relay.checkpoint().activeRun).toBeNull();
    // The old run's late stream is dropped, not relayed.
    expect(feed(relay, [...first.reply("a", "reply"), first.finished])).toEqual(
      [null, null, null, null]
    );
    expect(seen).toHaveLength(2);
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

  it("a clear by main mid-run: hydrate and rejoin see no run, and a kit-style client recovers once and follows the next run (review r2)", () => {
    const { relay, persisted } = make();
    const first = run("run-1", "hi");
    feed(relay, [
      hello("inc-1"),
      ...first.start,
      { type: "TEXT_MESSAGE_START", messageId: "a", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: "partial" },
    ]);

    // A client as the chat kit builds one (spec 02 §3.3): a generation is a
    // checkpoint, the active run's replay, then live events after the
    // cursor; `session.cleared` starts a new generation.
    const client = {
      generations: 0,
      processor: new StreamProcessor(),
      unsubscribe: () => undefined as void,
    };
    const generation = (): void => {
      client.generations += 1;
      client.unsubscribe();
      const { messages, activeRun, snapshot } = relay.checkpoint();
      const processor = new StreamProcessor({ initialMessages: messages });
      if (activeRun != null) {
        const joined = relay.joinRun(activeRun.runId, () => undefined);
        joined?.unsubscribe();
        for (const chunk of joined?.replay ?? [])
          processor.processChunk(
            restoreInboundChunk({ ...chunk.event } as StreamChunk)
          );
      }
      client.processor = processor;
      client.unsubscribe = relay.subscribe(snapshot.cursor, (chunk) => {
        const event = chunk.event as unknown as RelayEvent;
        if (event.type === "CUSTOM" && event.name === "session.cleared")
          return generation();
        processor.processChunk(
          restoreInboundChunk({ ...chunk.event } as StreamChunk)
        );
      }).unsubscribe;
    };
    generation();
    expect(textOf(client.processor.getMessages())).toMatchObject([
      { role: "user", text: "hi" },
      { role: "assistant", text: "partial" },
    ]);

    relay.clearByMain();
    // One new generation, from an empty checkpoint with no run to rejoin.
    expect(client.generations).toBe(2);
    const checkpoint = relay.checkpoint();
    expect(checkpoint.activeRun).toBeNull();
    expect(checkpoint.snapshot.activeRun).toBeNull();
    expect(checkpoint.messages).toEqual([]);
    expect(relay.joinRun("run-1", () => undefined)).toBeNull();
    expect(client.processor.getMessages()).toEqual([]);

    // The old run's tail reaches nobody.
    feed(relay, [
      { type: "TEXT_MESSAGE_CONTENT", messageId: "a", delta: " more" },
      { type: "TEXT_MESSAGE_END", messageId: "a" },
      first.finished,
    ]);
    expect(client.processor.getMessages()).toEqual([]);
    expect(persisted).toEqual([]);

    const second = run("run-2", "fresh");
    feed(relay, [...second.start, ...second.reply("b", "ok"), second.finished]);
    expect(client.generations).toBe(2);
    expect(textOf(client.processor.getMessages())).toEqual([
      { id: "run-2:user", role: "user", text: "fresh" },
      { id: "b", role: "assistant", text: "ok" },
    ]);
    expect(timeless(client.processor.getMessages())).toEqual(
      timeless(persisted.at(-1)!.messages)
    );
    client.unsubscribe();
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

const names = (chunks: readonly RelayChunk[]) =>
  chunks.map((chunk) => {
    const event = chunk.event as unknown as RelayEvent;
    return event.type === "CUSTOM" ? String(event.name) : event.type;
  });

/** A processor fed the way `ChatClient.processIncomingChunk` feeds one. */
const clientFrom = (
  messages: ReturnType<ThreadRelay["checkpoint"]>["messages"],
  chunks: readonly RelayChunk[]
) => {
  const processor = new StreamProcessor({ initialMessages: messages });
  for (const chunk of chunks)
    processor.processChunk(
      restoreInboundChunk(structuredClone(chunk.event)) as StreamChunk
    );
  return processor.getMessages();
};

describe("terminals main applies (review r1)", () => {
  it("a run that fails before any assistant output leaves the next run's user message a user message (main and a client alike)", () => {
    // Loaded from the file: the processor has no stream state of its own.
    const history: ThreadHistory = {
      messages: [
        { id: "u-0", role: "user", parts: [{ type: "text", content: "hi" }] },
        {
          id: "a-0",
          role: "assistant",
          parts: [{ type: "text", content: "hello" }],
        },
      ],
      runs: [],
    };
    const { relay, persisted } = make(history);
    const before = relay.checkpoint().messages;
    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));
    const runtime = {};

    // Run 1: the user echo only, then the process dies (main's terminal).
    feed(relay, [hello("inc-1"), ...run("run-1", "one", "u-1").start], runtime);
    relay.runtimeExited(runtime, "agent_crashed", "gone");
    // Run 2 on a new process, then an agent's own RUN_ERROR with no
    // assistant message (an agent without the anchor).
    const second = run("run-2", "two", "u-2");
    feed(
      relay,
      [
        hello("inc-2"),
        ...second.start,
        ...second.reply("a-2", "reply"),
        second.finished,
      ],
      {}
    );
    feed(relay, [
      ...run("run-3", "three", "u-3").start,
      {
        type: "RUN_ERROR",
        message: "provider down",
        code: "turn_failed",
        metadata: { tanstack: { threadId: "t-1", runId: "run-3" } },
      },
    ]);
    feed(relay, run("run-4", "four", "u-4").start);

    const roles = (messages: ReturnType<StreamProcessor["getMessages"]>) =>
      messages.map((message) => [message.id, message.role]);
    const expected = [
      ["u-0", "user"],
      ["a-0", "assistant"],
      ["u-1", "user"],
      ["run-1:error", "assistant"],
      ["u-2", "user"],
      ["a-2", "assistant"],
      ["u-3", "user"],
      ["run-3:error", "assistant"],
    ];
    expect(roles(persisted.at(-1)!.messages)).toEqual(expected);
    expect(persisted.at(-1)!.runs.at(-1)).toMatchObject({
      runId: "run-3",
      afterMessageId: "run-3:error",
    });
    // A client that watched it all holds the same, and so does main.
    const client = clientFrom(before, seen);
    expect(roles(client)).toEqual([...expected, ["u-4", "user"]]);
    expect(roles(relay.checkpoint().messages)).toEqual(expected);
  });

  it("closes the open tool call, reasoning, text and sub-agent before main's RUN_ERROR, so nothing streams forever", () => {
    const { relay, persisted } = make();
    const runtime = {};
    feed(
      relay,
      [
        hello("inc-1"),
        ...run("run-1", "go").start,
        { type: "TEXT_MESSAGE_START", messageId: "a-1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "a-1", delta: "Working" },
        { type: "REASONING_START", messageId: "a-1:think:1" },
        {
          type: "REASONING_MESSAGE_START",
          messageId: "a-1:think:1",
          role: "reasoning",
        },
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-1",
          toolCallName: "bash",
          parentMessageId: "a-1",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: '{"cmd":' },
        {
          type: "TOOL_CALL_START",
          toolCallId: "call-2",
          toolCallName: "delegate",
          parentMessageId: "a-1",
        },
        {
          type: "TOOL_CALL_END",
          toolCallId: "call-2",
          metadata: { tanstack: { input: {} } },
        },
        {
          type: "SUBAGENT_STARTED",
          subagentRunId: "child-1",
          name: "helper",
          parentToolCallId: "call-2",
        },
      ],
      runtime
    );
    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));
    relay.runtimeExited(runtime, "agent_crashed", "SIGKILL");

    expect(names(seen)).toEqual([
      "REASONING_MESSAGE_END",
      "REASONING_END",
      "TEXT_MESSAGE_END",
      "SUBAGENT_ERROR",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "TOOL_CALL_RESULT",
      "RUN_ERROR",
    ]);
    const parts = persisted.at(-1)!.messages.find((m) => m.id === "a-1")!
      .parts as unknown as Array<Record<string, unknown>>;
    const call = (id: string) =>
      parts.find((part) => part.type === "tool-call" && part.id === id)!;
    for (const id of ["call-1", "call-2"]) {
      expect(call(id).state).not.toBe("input-streaming");
      expect(call(id).state).not.toBe("awaiting-input");
      expect(
        parts.find(
          (part) => part.type === "tool-result" && part.toolCallId === id
        )
      ).toMatchObject({ state: "error" });
    }
    expect(
      parts.find((part) => part.type === "subagent") as unknown
    ).toMatchObject({ subagent: { id: "child-1", status: "error" } });
  });

  it("an exit resets the running-tools count with an authoritative heartbeat", () => {
    const { relay } = make();
    const runtime = {};
    feed(
      relay,
      [
        hello("inc-1"),
        custom("agent.status", { status: "streaming" }),
        custom("agent.heartbeat", { runningTools: 2 }),
      ],
      runtime
    );
    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));
    relay.runtimeExited(runtime, "agent_exit", "gone");

    expect(relay.checkpoint().snapshot.activity).toEqual({
      status: "idle",
      runningTools: 0,
    });
    expect(seen.map((chunk) => chunk.event)).toMatchObject([
      { name: "agent.status", value: { status: "idle" } },
      { name: "agent.heartbeat", value: { runningTools: 0 } },
    ]);
  });

  it("reads a terminal's run id as TanStack does: top-level runId first", () => {
    expect(terminalRunId({ type: "RUN_ERROR", runId: "top" })).toBe("top");
    expect(
      terminalRunId({
        type: "RUN_ERROR",
        metadata: { tanstack: { runId: "meta" } },
      })
    ).toBe("meta");
    const { relay } = make();
    feed(relay, [hello("inc-1"), ...run("run-2", "x").start]);
    // Another run's late error, named only at the top level: not this run's.
    expect(
      relay.ingest({ type: "RUN_ERROR", runId: "run-1", message: "late" })
    ).toBeNull();
    expect(relay.activeRunId).toBe("run-2");
  });
});

describe("checkpoints, resume and history (review r1)", () => {
  it("the checkpoint cursor is the thread's own last seq, not the global clock", () => {
    const clock = new SeqClock();
    const a = make(undefined, clock);
    const b = make(undefined, clock);
    const own = feed(a.relay, [hello("inc-a"), ...run("run-a", "x").start]);
    // Another thread keeps talking after this one's last event.
    feed(b.relay, [hello("inc-b"), custom("agent.status", { status: "idle" })]);

    const { snapshot } = a.relay.checkpoint();
    expect(snapshot.cursor).toBe(own.at(-1)!.seq);
    expect(snapshot.cursor).toBeLessThan(clock.current);
    // The active run's replay reaches the cursor: the kit's reconstruction
    // (appliedSeq ≥ N) completes without the other thread's events.
    const joined = a.relay.joinRun("run-a", () => undefined)!;
    expect(joined.replay.at(-1)!.seq).toBe(snapshot.cursor);
  });

  it("re-reads a v1-derived baseline before the first AG-UI run, so legacy turns are not lost", () => {
    const m = (id: string, content: string) => ({
      id,
      role: "user" as const,
      parts: [{ type: "text" as const, content }],
    });
    let onDisk: ThreadHistory = {
      messages: [m("v1-a", "first")],
      runs: [],
      migratedFrom: { updatedAt: "2026-01-01T00:00:00.000Z" },
      v1Derived: true,
    };
    const { relay, persisted } = make(structuredClone(onDisk), undefined, {
      reload: () => structuredClone(onDisk),
    });
    // The legacy runtime writes another turn to v1.
    onDisk = {
      ...onDisk,
      messages: [...onDisk.messages, m("v1-b", "second")],
      migratedFrom: { updatedAt: "2026-01-02T00:00:00.000Z" },
    };
    expect(relay.checkpoint().messages.map((x) => x.id)).toEqual([
      "v1-a",
      "v1-b",
    ]);
    onDisk = {
      ...onDisk,
      messages: [...onDisk.messages, m("v1-c", "third")],
      migratedFrom: { updatedAt: "2026-01-03T00:00:00.000Z" },
    };
    const first = run("run-1", "agui");
    feed(relay, [
      hello("inc-1"),
      ...first.start,
      ...first.reply("a-1", "ok"),
      first.finished,
    ]);

    expect(persisted.at(-1)!.messages.map((x) => x.id)).toEqual([
      "v1-a",
      "v1-b",
      "v1-c",
      "run-1:user",
      "a-1",
    ]);
    expect(persisted.at(-1)!.migratedFrom).toEqual({
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    // The relay's own file from here on: no more refreshes.
    onDisk = { ...onDisk, messages: [m("v1-z", "late")] };
    expect(relay.checkpoint().messages.map((x) => x.id)).not.toContain("v1-z");
  });

  it("feeds the processor what ChatClient feeds it (restoreInboundChunk), so metadata-only fields land the same", () => {
    const { relay, persisted } = make();
    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));
    const turn = run("run-1", "one");
    feed(relay, [
      hello("inc-1"),
      ...turn.start,
      { type: "TEXT_MESSAGE_START", messageId: "a-1", role: "assistant" },
      // The tool's name only in TanStack's metadata: ChatClient restores it
      // to the top level before processing, and the processor reads it there.
      {
        type: "TOOL_CALL_START",
        toolCallId: "call-1",
        parentMessageId: "a-1",
        metadata: { tanstack: { toolCallName: "bash" } },
      },
      {
        type: "TOOL_CALL_END",
        toolCallId: "call-1",
        metadata: { tanstack: { input: { cmd: "ls" } } },
      },
      { type: "TEXT_MESSAGE_END", messageId: "a-1" },
      turn.finished,
    ]);

    expect(timeless(persisted.at(-1)!.messages)).toEqual(
      timeless(clientFrom([], seen))
    );
    const call = persisted
      .at(-1)!
      .messages.flatMap((message) => message.parts)
      .find((part) => part.type === "tool-call") as { name?: string };
    expect(call.name).toBe("bash");
    // The ring keeps the event as the agent wrote it.
    expect(
      seen.find(
        (chunk) =>
          (chunk.event as unknown as RelayEvent).type === "TOOL_CALL_START"
      )!.event
    ).not.toHaveProperty("toolCallName");
  });

  it("says abacus.duplicate_echo for a user message the transcript already holds, dropped or never echoed", () => {
    const { relay } = make();
    const first = run("run-1", "question", "u-1");
    feed(relay, [
      hello("inc-1"),
      ...first.start,
      {
        type: "RUN_ERROR",
        message: "failed",
        metadata: { tanstack: { runId: "run-1" } },
      },
    ]);
    const seen: RelayChunk[] = [];
    relay.subscribe(null, (chunk) => seen.push(chunk));

    // A retry on a new process: it echoes u-1 again, which is dropped.
    feed(relay, [hello("inc-2"), ...run("run-2", "question", "u-1").start], {});
    expect(names(seen)).toEqual([
      "wire.hello",
      "RUN_STARTED",
      "abacus.duplicate_echo",
    ]);
    expect(seen.at(-1)!.event).toMatchObject({
      value: { runId: "run-2", messageId: "u-1" },
    });
    relay.failActiveRun("inactivity_timeout", "x");

    // A retry in the same process: the agent does not echo it at all.
    seen.length = 0;
    relay.expectEcho("run-3", "u-1");
    relay.ingest({ type: "RUN_STARTED", threadId: "t-1", runId: "run-3" });
    expect(names(seen)).toEqual(["RUN_STARTED", "abacus.duplicate_echo"]);
    // A new message is not a duplicate.
    relay.failActiveRun("inactivity_timeout", "x");
    seen.length = 0;
    relay.expectEcho("run-4", "u-new");
    relay.ingest({ type: "RUN_STARTED", threadId: "t-1", runId: "run-4" });
    expect(names(seen)).toEqual(["RUN_STARTED"]);
  });
});

describe("run logs stay bounded (review r1)", () => {
  it("past the cap, a call's live output coalesces to its latest", () => {
    const { relay } = make(undefined, undefined, { activeLogCap: 10 });
    feed(relay, [hello("inc-1"), ...run("run-1", "go").start]);
    const output = (n: number) =>
      custom("tool.output", { toolCallId: "call-1", output: `line ${n}` });
    for (let n = 0; n < 40; n += 1) relay.ingest(output(n));

    const log = relay.joinRun("run-1", () => undefined)!.replay;
    const outputs = log.filter(
      (chunk) => (chunk.event as unknown as RelayEvent).name === "tool.output"
    );
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.event).toMatchObject({
      value: { output: "line 39" },
    });
    // Still in seq order: a replay never goes backwards.
    const seqs = log.map((chunk) => chunk.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("finished logs expire after their grace period and past the count, and say so", () => {
    let now = 1_000;
    const forgotten: string[] = [];
    const { relay } = make(undefined, undefined, {
      now: () => now,
      onRunForgotten: (runId) => forgotten.push(runId),
    });
    relay.ingest(hello("inc-1"));
    const finish = (runId: string) => {
      const turn = run(runId, runId);
      feed(relay, [...turn.start, turn.finished]);
    };
    for (let n = 0; n <= FINISHED_LOGS_KEPT; n += 1) finish(`run-${n}`);
    expect(forgotten).toEqual(["run-0"]);
    expect(relay.joinRun("run-0", () => undefined)).toBeNull();
    expect(relay.joinRun("run-1", () => undefined)?.ended).toBe(true);

    now += FINISHED_LOG_TTL_MS + 1;
    relay.sweep();
    expect(forgotten).toHaveLength(FINISHED_LOGS_KEPT + 1);
    expect(relay.joinRun("run-1", () => undefined)).toBeNull();
    // The outcome is still in the transcript's records.
    expect(relay.hasFinished("run-1")).toBe(true);
  });
});

describe("applyJsonPatch", () => {
  it("refuses a path through a prototype key", () => {
    for (const path of [
      "/__proto__/polluted",
      "/constructor/prototype/polluted",
      "/prototype",
    ]) {
      expect(
        applyJsonPatch({ a: 1 }, [{ op: "add", path, value: true }])
      ).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // An inherited name is not a member to replace.
    expect(
      applyJsonPatch({ a: 1 }, [{ op: "replace", path: "/toString", value: 1 }])
    ).toBeNull();
  });

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
