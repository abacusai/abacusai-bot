/**
 * The `ai.*` procedures over main's AG-UI relay, through the real router and
 * oRPC adapters (`connectInProcess`), with a scripted agent standing in for
 * the runtime: every command main writes is recorded, and the test feeds the
 * AG-UI lines the agent would answer with. The spawned end-to-end run is in
 * `relay.e2e.test.ts`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentSessionStatus } from "@abacus-ai/contract/contracts";
import { getEventMeta } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import type { AgentWire } from "../session/cli-manager-service";
import { LegacyTranscriptFixture as TranscriptService } from "../session/legacy-transcript-fixture.test-support";
import { ThreadStore } from "../session/thread-store";
import { AguiRelayService, type AguiRelayHost } from "./relay-service";

type Command = { type: string } & Record<string, unknown>;

class ScriptedAgent {
  relay!: AguiRelayService;
  readonly sessions = new Map([["s1", "w1"]]);
  runtimeState: { wire: AgentWire; status: AgentSessionStatus } | null = null;
  readonly commands: Command[] = [];
  readonly marks: string[] = [];
  runtime = {};
  incarnation = "inc-1";
  starts = 0;
  /** What the agent answers a command with. */
  answer: (command: Command) => Array<Record<string, unknown>> = () => [];

  workspaceOf(threadId: string): string | null {
    return this.sessions.get(threadId) ?? null;
  }

  /** As `AgentManagerService.startSession`: the wire comes from the relay. */
  async start(threadId: string): Promise<boolean> {
    this.starts += 1;
    this.boot(threadId, this.incarnation, "agui");
    return true;
  }

  /** A fresh process: new identity and incarnation, hello first. */
  boot(
    threadId = "s1",
    incarnation = this.incarnation,
    wire: AgentWire = "agui"
  ): void {
    this.runtime = {};
    this.incarnation = incarnation;
    this.runtimeState = { wire, status: "running" };
    this.emit(threadId, {
      type: "CUSTOM",
      name: "wire.hello",
      value: { protocol: 1, wire: "agui", compat: "fd", incarnation },
    });
  }

  /** Returns the process written to, as `AgentManagerService` does. */
  send(threadId: string, command: object): object | null {
    if (this.runtimeState == null) return null;
    const typed = command as Command;
    this.commands.push(typed);
    const replies = this.answer(typed);
    queueMicrotask(() => {
      for (const reply of replies) this.emit(threadId, reply);
    });
    return this.runtime;
  }

  markSent(): void {
    this.marks.push("sent");
  }

  markStopped(): void {
    this.marks.push("stopped");
  }

  emit(threadId: string, event: Record<string, unknown>): void {
    this.relay.ingest(threadId, event, { wire: "agui", runtime: this.runtime });
  }
}

// The host the relay sees. `runtime` there is the method; on the agent it is
// the process identity.

const host = (agent: ScriptedAgent): AguiRelayHost => ({
  workspaceOf: (id) => agent.workspaceOf(id),
  runtime: () => agent.runtimeState,
  start: (id) => agent.start(id),
  send: (id, command) => agent.send(id, command),
  markSent: () => agent.markSent(),
  markStopped: () => agent.markStopped(),
});

const ack = (runId: string, status: string, extra: object = {}) => ({
  type: "CUSTOM",
  name: "run.ack",
  value: { runId, status, ...extra },
});

const started = (runId: string) => [
  ack(runId, "started"),
  { type: "RUN_STARTED", threadId: "s1", runId },
];

const finished = (runId: string) => ({
  type: "RUN_FINISHED",
  threadId: "s1",
  runId,
  outcome: { type: "success" },
});

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-relay-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const setup = (options: { ackTimeoutMs?: number } = {}) => {
  const agent = new ScriptedAgent();
  const store = new ThreadStore({ home: () => home, log: () => undefined });

  const relay = new AguiRelayService({
    host: host(agent),
    files: store,
    startTimeoutMs: 2_000,
    ackTimeoutMs: options.ackTimeoutMs ?? 2_000,
    log: () => undefined,
  });
  agent.relay = relay;
  const connection = connectInProcess(fakeDeps({ ai: relay }));
  return { agent, relay, store, client: connection.client, connection };
};

const userMessage = (id: string, content: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text", content }],
});

/** Reads `count` events from a stream, with their event ids. */
const take = async (
  stream: AsyncIterator<unknown>,
  count: number
): Promise<
  Array<{ id: string | undefined; event: Record<string, unknown> }>
> => {
  const out: Array<{ id: string | undefined; event: Record<string, unknown> }> =
    [];
  while (out.length < count) {
    const result = await stream.next();
    if (result.done === true) break;
    const event = result.value as Record<string, unknown>;
    out.push({ id: getEventMeta(event)?.id, event });
  }
  return out;
};

describe("ai.send", () => {
  it("starts an agui runtime, converts the UIMessages keeping their ids, and answers with the ack", async () => {
    const { agent, client } = setup();
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];

    const answer = await client.ai.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hello\nthere")],
      forwardedProps: { model: "m-2", whenBusy: "queue" },
    });

    expect(answer).toEqual({ runId: "run-1", status: "started" });
    expect(agent.starts).toBe(1);
    // Claimed by the call: the spawn it caused speaks AG-UI.

    expect(agent.marks).toEqual(["sent"]);
    expect(agent.commands).toEqual([
      {
        type: "run",
        input: {
          threadId: "s1",
          runId: "run-1",
          state: {},
          messages: [
            expect.objectContaining({
              id: "u-1",
              role: "user",
              content: "hello\nthere",
            }),
          ],
          tools: [],
          context: [],
          forwardedProps: { model: "m-2" },
        },
      },
    ]);
  });

  it("is idempotent by run id: a repeat waits for the first ack, and never writes run twice, across a respawn", async () => {
    const { agent, client } = setup();
    agent.boot();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    agent.answer = (command) => {
      if (command.type !== "run") return [];
      const runId = (command.input as { runId: string }).runId;
      void held.then(() => {
        for (const event of started(runId)) agent.emit("s1", event);
      });
      return [];
    };
    const input = {
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    };

    const first = client.ai.send(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const repeat = client.ai.send(input);
    release();

    await expect(first).resolves.toEqual({ runId: "run-1", status: "started" });
    await expect(repeat).resolves.toEqual({
      runId: "run-1",
      status: "duplicate",
      original: "started",
    });

    // A new agent process has an empty run-id memory; main does not.
    agent.emit("s1", finished("run-1"));
    agent.boot("s1", "inc-2");
    await expect(client.ai.send(input)).resolves.toMatchObject({
      status: "duplicate",
      original: "started",
    });
    expect(agent.commands.filter((c) => c.type === "run")).toHaveLength(1);
  });

  it("answers queued with the entry, and rejected without holding the turn busy", async () => {
    const { agent, client } = setup();
    agent.boot();
    agent.answer = (command) => {
      const runId = (command.input as { runId: string }).runId;
      return runId === "run-q"
        ? [ack(runId, "queued", { entryId: "q-1", waitingFor: "turn" })]
        : [ack(runId, "rejected", { reason: "empty" })];
    };

    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-q",
        messages: [userMessage("u", "x")],
      })
    ).resolves.toEqual({ runId: "run-q", status: "queued", entryId: "q-1" });
    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-r",
        messages: [userMessage("v", "")],
      })
    ).resolves.toEqual({ runId: "run-r", status: "rejected", reason: "empty" });
    expect(agent.marks).toEqual(["sent", "sent", "stopped"]);
    await expect(
      client.ai.send({ threadId: "s1", runId: "run-q", messages: [] })
    ).resolves.toEqual({
      runId: "run-q",
      status: "duplicate",
      original: "queued",
      entryId: "q-1",
    });
  });

  it("times out without an ack (uncertain), and records a late ack for the retry", async () => {
    const { agent, client } = setup({ ackTimeoutMs: 50 });
    agent.boot();
    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-1",
        messages: [userMessage("u", "x")],
      })
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    for (const event of started("run-1")) agent.emit("s1", event);
    await expect(
      client.ai.send({ threadId: "s1", runId: "run-1", messages: [] })
    ).resolves.toMatchObject({ status: "duplicate", original: "started" });
    expect(agent.commands).toHaveLength(1);
  });

  it("a runtime that exits before acking leaves the admission uncertain, and a retry writes again", async () => {
    const { agent, relay, client } = setup();
    agent.boot();
    const pending = client.ai.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u", "x")],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: agent.runtime },
      code: null,
      signal: "SIGKILL",
      requested: false,
    });
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });

    agent.boot("s1", "inc-2");
    agent.answer = (command) =>
      command.type === "run" ? started("run-1") : [];
    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-1",
        messages: [userMessage("u", "x")],
      })
    ).resolves.toEqual({ runId: "run-1", status: "started" });
    expect(agent.commands.filter((c) => c.type === "run")).toHaveLength(2);
  });
});

describe("ai.cancel, ai.respondPermission, ai.queue.*", () => {
  it("cancel: the open run stops the turn in main too; a stale id is only forwarded", async () => {
    const { agent, client } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);
    agent.emit("s1", finished("run-1"));
    for (const event of started("run-2")) agent.emit("s1", event);

    await client.ai.cancel({ threadId: "s1", runId: "run-1" });
    expect(agent.marks).toEqual([]);
    await client.ai.cancel({ threadId: "s1", runId: "run-2" });
    expect(agent.marks).toEqual(["stopped"]);
    await client.ai.cancel({ threadId: "s1" });
    expect(agent.commands).toEqual([
      { type: "cancel", runId: "run-1" },
      { type: "cancel", runId: "run-2" },
      { type: "cancel" },
    ]);
  });

  it("respondPermission writes permission.respond with the lineage, and validates first", async () => {
    const { agent, client } = setup();
    agent.boot();
    const lineage = {
      threadId: "s1",
      incarnation: "inc-1",
      turnSeq: 1,
      runId: "run-1",
      permissionId: "perm-1",
    };

    await client.ai.respondPermission({
      threadId: "s1",
      lineage,
      decision: { type: "allow_always_with_rules", rules: ["Bash(ls)"] },
    });
    await expect(
      client.ai.respondPermission({
        threadId: "s1",
        lineage: { ...lineage, threadId: "s2" },
        decision: "accept",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Never coerced to a rejection: a boolean is a bad request.
    await expect(
      client.ai.respondPermission({
        threadId: "s1",
        lineage,
        decision: true as never,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(agent.commands).toEqual([
      {
        type: "permission.respond",
        lineage,
        decision: { type: "allow_always_with_rules", rules: ["Bash(ls)"] },
      },
    ]);
  });

  it("queue edits go to the agent by incarnation and entry id, never by an index a drain can shift; a dead incarnation is refused here", async () => {
    const { agent, client } = setup();
    agent.boot();
    const queue = (...ids: string[]) => ({
      type: "CUSTOM",
      name: "queue.updated",
      value: {
        messages: ids.map((id) => ({ id, message: id, waitingFor: "turn" })),
        dequeued: null,
      },
    });
    agent.emit("s1", queue("q-1", "q-2"));
    // The agent drains q-1 right as the edit is on its way: main has not seen
    // that yet (its last queue says q-2 is at index 1). An index would now
    // name nothing, or another entry; the id still names q-2.
    agent.answer = (command) =>
      command.type === "queue.update" ? [queue("q-2")] : [];
    const stream = await client.ai.subscribe({ threadId: "s1" });
    const replayed = await take(stream, 3);
    const head = Number(replayed.at(-1)!.id);

    await client.ai.queue.update({
      threadId: "s1",
      incarnation: "inc-1",
      entryId: "q-2",
      message: "edited",
    });
    await client.ai.queue.remove({
      threadId: "s1",
      incarnation: "inc-0",
      entryId: "q-2",
    });
    await client.ai.queue.remove({
      threadId: "s1",
      incarnation: "inc-1",
      entryId: "q-9",
    });
    await client.ai.queue.enqueue({ threadId: "s1", message: "later" });
    await client.ai.queue.clear({ threadId: "s1" });
    await client.ai.queue.dequeue({ threadId: "s1" });

    expect(agent.commands).toEqual([
      {
        type: "queue.update",
        incarnation: "inc-1",
        entryId: "q-2",
        message: "edited",
      },
      // The agent answers a gone id itself, atomically (spec 02 §14.6).
      { type: "queue.remove", incarnation: "inc-1", entryId: "q-9" },
      { type: "enqueue", message: "later", hidden: false },
      { type: "clear_queue" },
      { type: "dequeue" },
    ]);
    expect(
      agent.commands.some((command) => Object.hasOwn(command, "index"))
    ).toBe(false);
    const answers = await take(stream, 3);
    expect(answers.map((entry) => entry.event)).toMatchObject([
      { name: "queue.updated" },
      {
        name: "queue.command_rejected",
        value: {
          incarnation: "inc-1",
          entryId: "q-2",
          command: "remove",
          reason: "incarnation",
        },
      },
      { name: "queue.updated" },
    ]);
    expect(Number(answers[0]!.id)).toBeGreaterThan(head);
    await stream.return?.(undefined);
  });

  it("every command needs a live agui runtime", async () => {
    const { client } = setup();
    await expect(
      client.ai.queue.enqueue({ threadId: "s1", message: "x" })
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // Nothing runs: there is nothing to cancel.
    await expect(client.ai.cancel({ threadId: "s1" })).resolves.toBeUndefined();
  });
});

describe("ai.subscribe, ai.hydrate, ai.joinRun", () => {
  it("subscribe: subscribed first (no event id), then replay after lastEventId, then live; resync for a lost point", async () => {
    const { agent, client } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);

    const first = await client.ai.subscribe({ threadId: "s1" });
    const [subscribed, ...replay] = await take(first, 4);
    expect(subscribed).toMatchObject({
      id: undefined,
      event: {
        type: "CUSTOM",
        name: "abacus.subscribed",
        value: { seq: expect.any(Number) },
      },
    });
    expect(replay.map((entry) => entry.event.type)).toEqual([
      "CUSTOM",
      "CUSTOM",
      "RUN_STARTED",
    ]);
    await first.return?.(undefined);

    const resumeAt = replay[1]!.id!;
    agent.emit("s1", finished("run-1"));
    const resumed = await client.ai.subscribe({
      threadId: "s1",
      lastEventId: resumeAt,
    });
    const events = await take(resumed, 3);
    expect(events.map((entry) => entry.event.type)).toEqual([
      "CUSTOM",
      "RUN_STARTED",
      "RUN_FINISHED",
    ]);
    await resumed.return?.(undefined);

    const lost = await client.ai.subscribe({
      threadId: "s1",
      lastEventId: "999999",
    });
    const [, resync] = await take(lost, 2);
    expect(resync).toMatchObject({
      id: undefined,
      event: { name: "abacus.resync" },
    });
    await lost.return?.(undefined);
  });

  it("a closed port releases every stream's listener, read or not", async () => {
    const { agent, relay, client, connection } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);

    const read = await client.ai.subscribe({ threadId: "s1" });
    await take(read, 1);
    await client.ai.subscribe({ threadId: "s1" });
    const joined = await client.ai.joinRun({ runId: "run-1" });
    await take(joined, 1);
    await vi.waitFor(() => expect(relay.listenerCount("s1")).toBe(3));

    // A reload: the renderer's end closes, oRPC aborts every iterator.
    connection.closeClient();
    await vi.waitFor(() => expect(relay.listenerCount("s1")).toBe(0));
  });

  it("hydrate: completed transcript without the active run, its checkpoint, and pages with their outcomes", async () => {
    const { agent, client } = setup();
    agent.boot();
    const turn = (runId: string, text: string) => [
      ...started(runId),
      { type: "TEXT_MESSAGE_START", messageId: `${runId}:user`, role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: `${runId}:user`, delta: text },
      { type: "TEXT_MESSAGE_END", messageId: `${runId}:user` },
      {
        type: "TEXT_MESSAGE_START",
        messageId: `${runId}:a`,
        role: "assistant",
      },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: `${runId}:a`,
        delta: `re ${text}`,
      },
      { type: "TEXT_MESSAGE_END", messageId: `${runId}:a` },
    ];
    for (const event of [...turn("run-1", "one"), finished("run-1")])
      agent.emit("s1", event);
    for (const event of [...turn("run-2", "two"), finished("run-2")])
      agent.emit("s1", event);
    for (const event of turn("run-3", "three")) agent.emit("s1", event);

    const all = await client.ai.hydrate({ threadId: "s1" });
    expect(all.messages.map((m) => m.id)).toEqual([
      "run-1:user",
      "run-1:a",
      "run-2:user",
      "run-2:a",
    ]);
    expect(all.activeRun).toEqual({ runId: "run-3" });
    expect(all.interrupts).toBeNull();
    expect(all.abacus.activeRun).toMatchObject({
      runId: "run-3",
      serverInitiated: false,
    });
    expect(all.abacus.incarnation).toBe("inc-1");
    expect(all.abacus.runOutcomes.map((o) => o.runId)).toEqual([
      "run-1",
      "run-2",
    ]);

    const newest = await client.ai.hydrate({ threadId: "s1", limit: 2 });
    expect(newest.messages.map((m) => m.id)).toEqual(["run-2:user", "run-2:a"]);
    expect(newest.page).toEqual({ truncated: true, cursor: "run-2:user" });
    expect(newest.abacus.runOutcomes.map((o) => o.runId)).toEqual(["run-2"]);
    const older = await client.ai.hydrate({
      threadId: "s1",
      limit: 2,
      before: "run-2:user",
    });
    expect(older.abacus.runOutcomes.map((o) => o.runId)).toEqual(["run-1"]);
    expect(older.page).toEqual({ truncated: false });
  });

  it("joinRun: from RUN_STARTED with event ids, then live, and returns after the terminal", async () => {
    const { agent, client } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);
    const { abacus } = await client.ai.hydrate({ threadId: "s1" });

    const joined = await client.ai.joinRun({ runId: "run-1" });
    const [start] = await take(joined, 1);
    expect(start).toMatchObject({
      id: String(abacus.activeRun!.startSeq),
      event: { type: "RUN_STARTED" },
    });
    agent.emit("s1", {
      type: "CUSTOM",
      name: "agent.status",
      value: { status: "idle" },
    });
    agent.emit("s1", finished("run-1"));
    const rest = await take(joined, 5);
    expect(rest.map((entry) => entry.event.type)).toEqual([
      "CUSTOM",
      "RUN_FINISHED",
    ]);

    // A finished run replays to its terminal; an unknown one returns at once.
    expect(
      (await take(await client.ai.joinRun({ runId: "run-1" }), 9)).length
    ).toBe(3);
    expect(await take(await client.ai.joinRun({ runId: "nope" }), 1)).toEqual(
      []
    );
  });

  it("persists an agui thread file and serves it after the relay is gone", async () => {
    const first = setup();
    first.agent.boot();
    for (const event of [...started("run-1"), finished("run-1")])
      first.agent.emit("s1", event);
    const file = first.store.readCurrentFile("s1");
    expect(file).toMatchObject({
      version: 2,
      source: { kind: "agui" },
      runs: [expect.objectContaining({ runId: "run-1", kind: "success" })],
    });

    // A new main process: the history and outcomes come back from the file.
    const second = setup();
    const hydrated = await second.client.ai.hydrate({ threadId: "s1" });
    expect(hydrated.abacus.runOutcomes.map((o) => o.runId)).toEqual(["run-1"]);
    expect(hydrated.abacus.cursor).toBe(0);
  });
});

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("ai.send admission (review r1)", () => {
  it("checks for a duplicate and reserves in one step: simultaneous sends of one run id write run once", async () => {
    const { agent, relay } = setup();
    agent.boot();
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];
    const input = {
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    };

    // No stagger: both calls start in the same turn.
    const answers = await Promise.all([relay.send(input), relay.send(input)]);

    expect(answers).toEqual([
      { runId: "run-1", status: "started" },
      { runId: "run-1", status: "duplicate", original: "started" },
    ]);
    expect(agent.commands.filter((c) => c.type === "run")).toHaveLength(1);
  });

  it("converts before reserving: a message it cannot convert is BAD_REQUEST, and the run id stays free", async () => {
    const { agent, client } = setup();
    agent.boot();
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];
    // The loose contract admits it; the converter throws (no subagent.name).
    const bad = {
      threadId: "s1",
      runId: "run-1",
      messages: [
        userMessage("u-1", "hi"),
        {
          id: "a-1",
          role: "assistant" as const,
          parts: [{ type: "subagent" }],
        },
      ],
    };

    await expect(client.ai.send(bad)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(agent.commands).toEqual([]);
    expect(agent.marks).toEqual([]);
    // Nothing waits under that run id: a corrected send goes through.
    await expect(
      client.ai.send({ ...bad, messages: [userMessage("u-1", "hi")] })
    ).resolves.toEqual({ runId: "run-1", status: "started" });
  });

  it("an unwritable runtime undoes the turn state, and a repeat awaiting the admission gets the same definitive answer", async () => {
    const { agent, relay } = setup();
    agent.boot();
    agent.send = () => null;
    const input = {
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    };

    const results = await Promise.allSettled([
      relay.send(input),
      relay.send(input),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    for (const result of results)
      expect((result as PromiseRejectedResult).reason).toMatchObject({
        code: "UNAVAILABLE",
      });
    expect(agent.marks).toEqual(["sent", "stopped"]);
  });

  it("an obsolete process's exit leaves its replacement's admission waiting for its own ack", async () => {
    const { agent, relay } = setup();
    agent.boot("s1", "inc-1");
    const old = agent.runtime;
    // The replacement is up while the old child is still dying.
    agent.boot("s1", "inc-2");
    let answer!: () => void;
    agent.answer = (command) => {
      if (command.type !== "run") return [];
      answer = () => {
        for (const event of started("run-1")) agent.emit("s1", event);
      };
      return [];
    };
    const pending = relay.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    });
    await vi.waitFor(() => expect(agent.commands).toHaveLength(1));

    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: old },
      code: null,
      signal: "SIGTERM",
      requested: false,
    });
    answer();

    await expect(pending).resolves.toEqual({
      runId: "run-1",
      status: "started",
    });
    expect(agent.commands.filter((c) => c.type === "run")).toHaveLength(1);
  });

  it("binds an admission to the process that received run, even when the replacement's ready precedes its wire.hello (review r2)", async () => {
    const { agent, relay } = setup();
    agent.boot("s1", "inc-1");
    const old = agent.runtime;
    // The replacement's compat `ready` is in (the host reports it running),
    // but its `wire.hello` has not reached the relay: stdout still names
    // the old process.
    agent.runtime = {};
    const replacement = agent.runtime;
    agent.runtimeState = { wire: "agui", status: "running" };
    let answer!: () => void;
    agent.answer = (command) => {
      if (command.type !== "run") return [];
      answer = () => {
        agent.emit("s1", {
          type: "CUSTOM",
          name: "wire.hello",
          value: {
            protocol: 1,
            wire: "agui",
            compat: "fd",
            incarnation: "inc-2",
          },
        });
        for (const event of started("run-1")) agent.emit("s1", event);
      };
      return [];
    };
    const pending = relay.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    });
    await vi.waitFor(() => expect(agent.commands).toHaveLength(1));

    // The old process dies: `run` never reached it.
    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: old },
      code: null,
      signal: "SIGTERM",
      requested: false,
    });
    answer();
    await expect(pending).resolves.toEqual({
      runId: "run-1",
      status: "started",
    });

    // The replacement's own exit is what leaves an admission uncertain.
    agent.answer = () => [];
    const second = relay.send({
      threadId: "s1",
      runId: "run-2",
      messages: [userMessage("u-2", "again")],
    });
    await vi.waitFor(() => expect(agent.commands).toHaveLength(2));
    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: replacement },
      code: null,
      signal: "SIGKILL",
      requested: false,
    });
    await expect(second).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(relay.admissionThreads).toBe(0);
  });

  it("keeps no empty per-thread admission maps, and forgetting a session answers its admissions (review r2)", async () => {
    const { agent, relay } = setup();
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];
    await relay.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hi")],
    });
    agent.emit("s1", finished("run-1"));
    expect(relay.admissionThreads).toBe(0);

    // Written, unanswered: forgetting the session is a definitive NOT_FOUND.
    agent.answer = () => [];
    const written = relay.send({
      threadId: "s1",
      runId: "run-2",
      messages: [userMessage("u-2", "x")],
    });
    await vi.waitFor(() => expect(agent.commands).toHaveLength(2));
    expect(relay.admissionThreads).toBe(1);
    relay.forgetThread("s1");
    await expect(written).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(relay.admissionThreads).toBe(0);

    // Waiting for a runtime that is still starting: never written.
    agent.runtimeState = { wire: "agui", status: "starting" };
    const unwritten = relay.send({
      threadId: "s1",
      runId: "run-3",
      messages: [userMessage("u-3", "y")],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    relay.forgetThread("s1");
    agent.runtimeState = { wire: "agui", status: "running" };
    await expect(unwritten).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(agent.commands).toHaveLength(2);
    expect(relay.admissionThreads).toBe(0);
  });

  it("two first sends on a cold thread start the agent once", async () => {
    const { agent, relay } = setup();
    agent.start = async (threadId: string) => {
      agent.starts += 1;
      await sleep(20);
      agent.boot(threadId, agent.incarnation, "agui");
      return true;
    };
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];

    const answers = await Promise.all([
      relay.send({
        threadId: "s1",
        runId: "run-a",
        messages: [userMessage("u-a", "a")],
      }),
      relay.send({
        threadId: "s1",
        runId: "run-b",
        messages: [userMessage("u-b", "b")],
      }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([
      "started",
      "started",
    ]);
    expect(agent.starts).toBe(1);
  });

  it("an agent duplicate main has no record of is a duplicate with no guessed original", async () => {
    const { agent, client } = setup();
    agent.boot();
    agent.answer = (command) =>
      command.type === "run"
        ? [ack((command.input as { runId: string }).runId, "duplicate")]
        : [];

    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-x",
        messages: [userMessage("u", "x")],
      })
    ).resolves.toEqual({ runId: "run-x", status: "duplicate" });
  });

  it("a retry of a message the transcript holds, which the agent does not echo again, says abacus.duplicate_echo", async () => {
    const { agent, client } = setup();
    agent.boot();
    agent.answer = (command) => {
      if (command.type !== "run") return [];
      const runId = (command.input as { runId: string }).runId;
      return runId === "run-1"
        ? [
            ...started(runId),
            { type: "TEXT_MESSAGE_START", messageId: "u-1", role: "user" },
            { type: "TEXT_MESSAGE_CONTENT", messageId: "u-1", delta: "q" },
            { type: "TEXT_MESSAGE_END", messageId: "u-1" },
            {
              type: "RUN_ERROR",
              message: "failed",
              metadata: { tanstack: { runId } },
            },
          ]
        : // The same process remembers it echoed u-1: no echo this time.
          started(runId);
    };
    await client.ai.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "q")],
    });
    const stream = await client.ai.subscribe({ threadId: "s1" });
    const [subscribed] = await take(stream, 1);
    const head = Number(
      (subscribed!.event.value as { seq: number } | undefined)?.seq
    );

    await client.ai.send({
      threadId: "s1",
      runId: "run-2",
      messages: [userMessage("u-1", "q")],
    });

    let notice: Record<string, unknown> | undefined;
    while (notice == null) {
      const [next] = await take(stream, 1);
      if (next == null) break;
      if (Number(next.id) <= head) continue;
      if (next.event.name === "abacus.duplicate_echo") notice = next.event;
    }
    expect(notice).toMatchObject({
      value: { runId: "run-2", messageId: "u-1" },
    });
    await stream.return?.(undefined);
  });
});

describe("streams, checkpoints and cancel (review r1)", () => {
  it("cancel marks the turn stopped only for the open run or an admission that will open it", async () => {
    const { agent, relay, client } = setup();
    agent.boot();
    for (const event of [...started("run-1"), finished("run-1")])
      agent.emit("s1", event);
    // A reset forgets run-1's outcome and log; its ack stays remembered.
    relay.clearThread("s1");
    for (const event of started("run-2")) agent.emit("s1", event);

    await client.ai.cancel({ threadId: "s1", runId: "run-1" });
    expect(agent.marks).toEqual([]);

    // Acked `started`, RUN_STARTED not yet seen: current.
    agent.emit("s1", finished("run-2"));
    agent.emit("s1", ack("run-3", "started"));
    await client.ai.cancel({ threadId: "s1", runId: "run-3" });
    expect(agent.marks).toEqual(["stopped"]);
    for (const event of [...started("run-3").slice(1), finished("run-3")])
      agent.emit("s1", event);
    await client.ai.cancel({ threadId: "s1", runId: "run-3" });
    expect(agent.marks).toEqual(["stopped"]);
  });

  it("a subscriber that overflows while parked is detached at once", () => {
    const { agent, relay } = setup();
    agent.boot();
    const controller = new AbortController();
    // Never read: flow control holds the consumer back.
    relay.subscribe("s1", null, controller.signal);
    expect(relay.listenerCount("s1")).toBe(1);

    for (let n = 0; n <= 10_000; n += 1)
      agent.emit("s1", {
        type: "CUSTOM",
        name: "agent.heartbeat",
        value: { runningTools: n % 2 },
      });

    expect(relay.listenerCount("s1")).toBe(0);
    controller.abort();
  });

  it("NOT_FOUND for a thread main does not know, and for an unknown page cursor", async () => {
    const { agent, client } = setup();
    await expect(client.ai.hydrate({ threadId: "gone" })).rejects.toMatchObject(
      { code: "NOT_FOUND" }
    );
    await expect(
      client.ai.subscribe({ threadId: "gone" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    agent.boot();
    for (const event of [...started("run-1"), finished("run-1")])
      agent.emit("s1", event);
    await expect(
      client.ai.hydrate({ threadId: "s1", limit: 1, before: "nope" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a resume point from another relay epoch is resync, never a replay", async () => {
    const { agent, client, relay } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);

    const other = await client.ai.subscribe({
      threadId: "s1",
      lastEventId: "1",
      epoch: "another-main-process",
    });
    const [, resync] = await take(other, 2);
    expect(resync!.event).toMatchObject({ name: "abacus.resync" });
    await other.return?.(undefined);

    const same = await client.ai.subscribe({
      threadId: "s1",
      lastEventId: "1",
      epoch: relay.epoch,
    });
    const [, replay] = await take(same, 2);
    expect(replay!.id).toBe("2");
    await same.return?.(undefined);
  });

  it("a reset by main is session.cleared on every open stream", async () => {
    const { agent, client, relay } = setup();
    agent.boot();
    const stream = await client.ai.subscribe({ threadId: "s1" });
    await take(stream, 2);

    relay.clearThread("s1");

    const [cleared] = await take(stream, 1);
    expect(cleared!.event).toMatchObject({
      type: "CUSTOM",
      name: "session.cleared",
    });
    expect(cleared!.id).toBeDefined();
    await stream.return?.(undefined);
  });

  it("a reset by main mid-run retires the run first: hydrate has no active run, rejoin has nothing, and its tail is dropped (review r2)", async () => {
    const { agent, client, relay } = setup();
    agent.boot();
    for (const event of started("run-1")) agent.emit("s1", event);
    agent.emit("s1", {
      type: "TEXT_MESSAGE_START",
      messageId: "a",
      role: "assistant",
    });
    const stream = await client.ai.subscribe({ threadId: "s1" });
    await take(stream, 5);

    relay.clearThread("s1");
    const retired = await take(stream, 3);
    expect(retired.map((entry) => entry.event)).toMatchObject([
      { type: "TEXT_MESSAGE_END", messageId: "a" },
      { type: "RUN_FINISHED", runId: "run-1", outcome: { type: "cancelled" } },
      { type: "CUSTOM", name: "session.cleared" },
    ]);

    // The kit's new generation: an empty checkpoint, no run to rejoin.
    const hydrated = await client.ai.hydrate({ threadId: "s1" });
    expect(hydrated.messages).toEqual([]);
    expect(hydrated.activeRun).toBeNull();
    expect(hydrated.abacus.activeRun).toBeNull();
    expect(await take(await client.ai.joinRun({ runId: "run-1" }), 1)).toEqual(
      []
    );
    const resumed = await client.ai.subscribe({
      threadId: "s1",
      lastEventId: String(hydrated.abacus.cursor),
      epoch: hydrated.abacus.epoch,
    });
    expect((await take(resumed, 1))[0]!.event).toMatchObject({
      name: "abacus.subscribed",
    });

    // The old run's tail reaches no stream; the next run does.
    agent.emit("s1", {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "a",
      delta: "late",
    });
    agent.emit("s1", finished("run-1"));
    agent.emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-2" });
    for (const open of [stream, resumed])
      expect((await take(open, 1))[0]!.event).toMatchObject({
        type: "RUN_STARTED",
        runId: "run-2",
      });
    await stream.return?.(undefined);
    await resumed.return?.(undefined);
  });
});

describe("v1-derived baseline (step-1 review r2 #11)", () => {
  it("a same-millisecond legacy save reaches the relay's baseline through the fingerprint", async () => {
    const previous = process.env.ABACUSAI_BOT_HOME;
    process.env.ABACUSAI_BOT_HOME = home;
    try {
      const { store, client } = setup();
      const clock = new Date("2026-09-01T10:00:00.000Z");
      const transcripts = new TranscriptService({
        threads: store,
        now: () => clock,
        isWriteBlocked: () => false,
      });
      const text = (id: string, source: string) => ({
        type: "text",
        id,
        source,
        content: id,
      });
      transcripts.write("s1", [text("u1", "user"), text("b1", "bot")]);
      const first = await client.ai.hydrate({ threadId: "s1" });
      expect(first.messages.map((message) => message.id)).toEqual(["u1", "b1"]);
      // The old renderer saves again within the same millisecond.
      transcripts.write("s1", [
        text("u1", "user"),
        text("b1", "bot"),
        text("u2", "user"),
      ]);
      const second = await client.ai.hydrate({ threadId: "s1" });
      expect(second.messages.map((message) => message.id)).toEqual([
        "u1",
        "b1",
        "u2",
      ]);
    } finally {
      if (previous === undefined) delete process.env.ABACUSAI_BOT_HOME;
      else process.env.ABACUSAI_BOT_HOME = previous;
    }
  });
});

it("a deleted session cannot regain attention from buffered child output", async () => {
  const { agent, relay } = setup();
  agent.boot();
  const pending = {
    type: "CUSTOM",
    name: "permission.pending",
    value: {
      incarnation: "inc-1",
      items: [
        {
          id: "p",
          message: "permission",
          metadata: { abacus: { lineage: { incarnation: "inc-1" } } },
        },
      ],
    },
  };
  agent.emit("s1", pending);
  relay.forgetThread("s1");
  agent.sessions.delete("s1");
  agent.emit("s1", pending);
  agent.emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "late" });
  const signal = new AbortController();
  const stream = relay.attention(signal.signal)[Symbol.asyncIterator]();
  expect((await stream.next()).value).toMatchObject({
    type: "snapshot",
    items: [],
  });
  expect(relay.busy).toBe(false);
  signal.abort();
  await stream.return?.();
});

it("an acked run belongs to the process that acknowledged it, even if its exit arrives after a replacement hello", async () => {
  const { agent, relay } = setup();
  agent.boot();
  const old = agent.runtime;
  agent.emit("s1", ack("old-run", "started"));
  expect(relay.busy).toBe(true);
  agent.boot("s1", "inc-2");
  expect(relay.busy).toBe(false);
  agent.emit("s1", ack("new-run", "started"));
  relay.runtimeExited("s1", {
    origin: { wire: "agui", runtime: old },
    code: 1,
    signal: null,
    requested: false,
  });
  expect(relay.busy).toBe(true);
  relay.runtimeExited("s1", {
    origin: { wire: "agui", runtime: agent.runtime },
    code: 1,
    signal: null,
    requested: false,
  });
  expect(relay.busy).toBe(false);
});

it("invalid native ids and mismatched conversation ids do not claim the thread's next spawn", async () => {
  const { relay } = setup();
  for (const input of [
    { threadId: "s1", runId: "bad#run", messages: [] },
    {
      threadId: "s1",
      runId: "good",
      messages: [],
      forwardedProps: { conversationId: "other" },
    },
  ]) {
    await expect(relay.send(input)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  }
});

it("run-finished cursors older than retention require resync, including a cursor in a seq gap", () => {
  const { agent, relay } = setup();
  agent.boot();
  for (let i = 0; i < 1002; i++) {
    agent.emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: `r${i}` });
    agent.emit("s1", finished(`r${i}`));
  }
  expect(() => relay.runFinished(0, new AbortController().signal)).toThrow(
    expect.objectContaining({ code: "RESYNC_REQUIRED" })
  );
  expect(() => relay.runFinished(1, new AbortController().signal)).toThrow(
    expect.objectContaining({ code: "RESYNC_REQUIRED" })
  );
});

it("passes operator display tags through ai.send without rewriting the wire prompt", async () => {
  const { agent, client } = setup();
  agent.answer = (command) =>
    command.type === "run"
      ? started((command.input as { runId: string }).runId)
      : [];
  const content = "rules\n\n[Ada] hello";
  const userText = { operator: { kind: "auto-reply-intro", visibleFrom: 7 } };
  await client.ai.send({
    threadId: "s1",
    runId: "op-run",
    messages: [
      {
        ...userMessage("op-user", content),
        metadata: { abacus: { userText } },
      },
    ],
  });
  expect(
    (agent.commands[0]?.input as { messages: unknown[] }).messages[0]
  ).toMatchObject({
    id: "op-user",
    role: "user",
    content,
    metadata: { abacus: { userText } },
  });
});
