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

import { getEventMeta } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentSessionStatus } from "#shared/contracts";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import type { AgentWire } from "../session/cli-manager-service";
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
    this.boot(threadId, this.incarnation, this.relay.wireFor(threadId));
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

  send(threadId: string, command: object): boolean {
    if (this.runtimeState == null) return false;
    const typed = command as Command;
    this.commands.push(typed);
    const replies = this.answer(typed);
    queueMicrotask(() => {
      for (const reply of replies) this.emit(threadId, reply);
    });
    return true;
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
    aguiForEverySpawn: false,
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
    const { agent, relay, client } = setup();
    agent.answer = (command) =>
      command.type === "run"
        ? started((command.input as { runId: string }).runId)
        : [];
    expect(relay.wireFor("s1")).toBe("ndjson");

    const answer = await client.ai.send({
      threadId: "s1",
      runId: "run-1",
      messages: [userMessage("u-1", "hello\nthere")],
      forwardedProps: { model: "m-2", whenBusy: "queue" },
    });

    expect(answer).toEqual({ runId: "run-1", status: "started" });
    expect(agent.starts).toBe(1);
    // Claimed by the call: the spawn it caused speaks AG-UI.
    expect(relay.wireFor("s1")).toBe("agui");
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

  it("raises NOT_FOUND and UNAVAILABLE before writing run", async () => {
    const { agent, client } = setup();
    await expect(
      client.ai.send({ threadId: "gone", runId: "r", messages: [] })
    ).rejects.toMatchObject({ code: "NOT_FOUND", data: { entity: "session" } });

    // A runtime already running the legacy protocol for this thread.
    agent.runtimeState = { wire: "ndjson", status: "running" };
    await expect(
      client.ai.send({ threadId: "s1", runId: "r", messages: [] })
    ).rejects.toMatchObject({ code: "UNAVAILABLE", defined: true });
    expect(agent.commands).toEqual([]);
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

  it("queue edits are checked against the live incarnation and entry id, then sent by index", async () => {
    const { agent, client } = setup();
    agent.boot();
    agent.emit("s1", {
      type: "CUSTOM",
      name: "queue.updated",
      value: {
        messages: [
          { id: "q-1", message: "hidden", hidden: true, waitingFor: "step" },
          { id: "q-2", message: "shown", waitingFor: "turn" },
        ],
        dequeued: null,
      },
    });
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
      { type: "update_queue_item", index: 1, message: "edited" },
      { type: "enqueue", message: "later", hidden: false },
      { type: "clear_queue" },
      { type: "dequeue" },
    ]);
    const answers = await take(stream, 4);
    expect(answers.map((entry) => entry.event)).toMatchObject([
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
      {
        name: "queue.command_rejected",
        value: { entryId: "q-9", reason: "not_found" },
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
