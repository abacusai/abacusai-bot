/**
 * R3-T28 (main side, spec 03 §24.11): `ai.runFinished` through the real
 * router, published once per run id at the relay's authoritative terminal,
 * with `hasVisibleAssistantText`, the session's parentage, and the terminal's
 * seq as its event id for a `lastEventId` resume.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getEventMeta } from "@orpc/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunFinishedNotice } from "#shared/contract";
import type { AgentSessionStatus, SessionOwner } from "#shared/contracts";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import type { AgentWire } from "../session/cli-manager-service";
import { ThreadStore } from "../session/thread-store";
import { AguiRelayService, NOTICES_KEPT } from "./relay-service";

type Event = Record<string, unknown>;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-run-finished-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const owners = new Map<
    string,
    { owner: SessionOwner | null; routineId: string | null }
  >();
  let runtimeState: { wire: AgentWire; status: AgentSessionStatus } | null =
    null;
  let runtime = {};
  const commands: Array<Record<string, unknown>> = [];
  let answer: (command: Record<string, unknown>) => Event[] = () => [];
  const relay: AguiRelayService = new AguiRelayService({
    host: {
      workspaceOf: () => "w1",
      runtime: () => runtimeState,
      start: async () => true,
      send: (threadId, command) => {
        if (runtimeState == null) return null;
        commands.push(command as Record<string, unknown>);
        const replies = answer(command as Record<string, unknown>);
        queueMicrotask(() => {
          for (const reply of replies)
            relay.ingest(threadId, reply, { wire: "agui", runtime });
        });
        return runtime;
      },
      markSent: () => undefined,
      markStopped: () => undefined,
      ownerOf: (threadId) =>
        owners.get(threadId) ?? { owner: null, routineId: null },
    },
    files: new ThreadStore({ home: () => home, log: () => undefined }),
    aguiForEverySpawn: true,
    startTimeoutMs: 1_000,
    ackTimeoutMs: 1_000,
    log: () => undefined,
  });
  const emit = (threadId: string, event: Event): void =>
    relay.ingest(threadId, event, { wire: "agui", runtime });
  const boot = (threadId = "s1", incarnation = "inc-1"): object => {
    runtime = {};
    runtimeState = { wire: "agui", status: "running" };
    emit(threadId, {
      type: "CUSTOM",
      name: "wire.hello",
      value: { protocol: 1, wire: "agui", compat: "fd", incarnation },
    });
    return runtime;
  };
  const connection = connectInProcess(fakeDeps({ ai: relay }));
  return {
    relay,
    emit,
    boot,
    owners,
    commands,
    setAnswer: (next: typeof answer) => {
      answer = next;
    },
    client: connection.client,
  };
};

const text = (messageId: string, role: string, content: string): Event[] => [
  { type: "TEXT_MESSAGE_START", messageId, role },
  { type: "TEXT_MESSAGE_CONTENT", messageId, delta: content },
  { type: "TEXT_MESSAGE_END", messageId },
];

const toolRound = (toolCallId: string): Event[] => [
  { type: "TOOL_CALL_START", toolCallId, toolCallName: "bash" },
  { type: "TOOL_CALL_ARGS", toolCallId, delta: "{}" },
  { type: "TOOL_CALL_END", toolCallId },
  {
    type: "TOOL_CALL_RESULT",
    messageId: `${toolCallId}:result`,
    toolCallId,
    role: "tool",
    content: JSON.stringify({ text: "ok", rejected: false }),
  },
];

const read = async (
  stream: AsyncIterator<unknown>,
  count: number
): Promise<Array<{ id: string | undefined; notice: RunFinishedNotice }>> => {
  const out: Array<{ id: string | undefined; notice: RunFinishedNotice }> = [];
  while (out.length < count) {
    const result = await stream.next();
    if (result.done === true) break;
    const notice = result.value as RunFinishedNotice;
    out.push({ id: getEventMeta(notice)?.id, notice });
  }
  return out;
};

/** Everything already delivered, without waiting for more. */
const drainNow = async (
  stream: AsyncIterator<unknown>
): Promise<RunFinishedNotice[]> => {
  const out: RunFinishedNotice[] = [];
  for (;;) {
    const next = await Promise.race([
      stream.next(),
      new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 30)),
    ]);
    if (next === "idle" || next.done === true) return out;
    out.push(next.value as RunFinishedNotice);
  }
};

describe("ai.runFinished (spec 03 §24.11)", () => {
  it("several tool rounds publish one notice, with the owner and a visible reply", async () => {
    const { client, emit, boot, owners } = setup();
    const owner: SessionOwner = {
      kind: "bot",
      botId: "bot-1",
      role: "forever",
      key: null,
    };
    owners.set("s1", { owner, routineId: null });
    boot();
    const stream = await client.ai.runFinished({});

    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-1" });
    for (const event of [
      ...text("u1", "user", "do it"),
      ...text("a1", "assistant", "Looking."),
      ...toolRound("t1"),
      ...text("a2", "assistant", "Still going."),
      ...toolRound("t2"),
      ...toolRound("t3"),
      ...text("a3", "assistant", "Done: 3 files."),
    ])
      emit("s1", event);
    // Compat's between-rounds `turn_complete` never reaches the relay; an
    // idle status between rounds is not a terminal either.
    emit("s1", {
      type: "CUSTOM",
      name: "agent.status",
      value: { status: "idle" },
    });
    emit("s1", {
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "run-1",
      outcome: { type: "success" },
      timestamp: 1234,
    });
    // A late duplicate terminal of the same run: first terminal wins.
    emit("s1", {
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "run-1",
      outcome: { type: "success" },
    });

    const [first] = await read(stream, 1);
    expect(first!.notice).toEqual({
      threadId: "s1",
      runId: "run-1",
      outcome: "success",
      hasVisibleAssistantText: true,
      owner,
      routineId: null,
      at: 1234,
    });
    expect(Number(first!.id)).toBeGreaterThan(0);
    expect(await drainNow(stream)).toEqual([]);
    await stream.return?.(undefined);
  });

  it("an idle followed by a terminal error publishes one error with its code", async () => {
    const { client, emit, boot } = setup();
    boot();
    const stream = await client.ai.runFinished({});
    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-1" });
    emit("s1", {
      type: "CUSTOM",
      name: "agent.status",
      value: { status: "idle" },
    });
    emit("s1", {
      type: "RUN_ERROR",
      message: "Rate limited",
      code: "rate_limited",
      metadata: { tanstack: { threadId: "s1", runId: "run-1" } },
    });

    const notices = [
      ...(await read(stream, 1)).map((n) => n.notice),
      ...(await drainNow(stream)),
    ];
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      runId: "run-1",
      outcome: "error",
      errorCode: "rate_limited",
      hasVisibleAssistantText: false,
    });
    await stream.return?.(undefined);
  });

  it("a crash publishes agent_crashed; main's own inactivity terminal wins over the agent's late one", async () => {
    const { client, emit, boot, relay } = setup();
    const process1 = boot();
    const stream = await client.ai.runFinished({});
    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-1" });
    for (const event of text("a1", "assistant", "Half")) emit("s1", event);
    relay.runtimeExited("s1", {
      origin: { wire: "agui", runtime: process1 },
      code: null,
      signal: "SIGKILL",
      requested: false,
    });

    boot("s1", "inc-2");
    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-2" });
    relay.failActiveRun("s1", "inactivity_timeout", "No output for 10 minutes");
    emit("s1", {
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "run-2",
      outcome: { type: "success" },
    });

    const notices = [
      ...(await read(stream, 2)).map((n) => n.notice),
      ...(await drainNow(stream)),
    ];
    expect(notices.map((n) => [n.runId, n.outcome, n.errorCode])).toEqual([
      ["run-1", "error", "agent_crashed"],
      ["run-2", "error", "inactivity_timeout"],
    ]);
    // The crashed run had text; the timed-out one had none.
    expect(notices.map((n) => n.hasVisibleAssistantText)).toEqual([
      true,
      false,
    ]);
    await stream.return?.(undefined);
  });

  it("a silent NO_REPLY run has hasVisibleAssistantText false; whitespace is not visible either", async () => {
    const { client, emit, boot, owners } = setup();
    owners.set("s1", { owner: null, routineId: "routine-9" });
    boot();
    const stream = await client.ai.runFinished({});
    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-1" });
    for (const event of [
      ...text("a1", "assistant", "  NO_REPLY \n"),
      ...text("a2", "assistant", "   "),
    ])
      emit("s1", event);
    emit("s1", {
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "run-1",
      outcome: { type: "success" },
    });
    // A later run's text does not make an earlier silent run visible, and an
    // earlier run's text does not make this one visible.
    emit("s1", { type: "RUN_STARTED", threadId: "s1", runId: "run-2" });
    emit("s1", {
      type: "RUN_FINISHED",
      threadId: "s1",
      runId: "run-2",
      outcome: { type: "cancelled" },
    });

    const notices = (await read(stream, 2)).map((n) => n.notice);
    expect(notices).toMatchObject([
      {
        runId: "run-1",
        outcome: "success",
        hasVisibleAssistantText: false,
        owner: null,
        routineId: "routine-9",
      },
      { runId: "run-2", outcome: "cancelled", hasVisibleAssistantText: false },
    ]);
    await stream.return?.(undefined);
  });

  it("command errors are not runs: a rejected or queued admission publishes nothing", async () => {
    const { client, boot, setAnswer } = setup();
    boot();
    const stream = await client.ai.runFinished({});
    setAnswer((command) => {
      const runId = (command.input as { runId: string } | undefined)?.runId;
      return runId == null
        ? []
        : [
            {
              type: "CUSTOM",
              name: "run.ack",
              value:
                runId === "run-r"
                  ? { runId, status: "rejected", reason: "empty" }
                  : { runId, status: "queued", entryId: "e1" },
            },
          ];
    });
    const message = {
      id: "u1",
      role: "user" as const,
      parts: [{ type: "text", content: "hi" }],
    };
    await expect(
      client.ai.send({ threadId: "s1", runId: "run-r", messages: [message] })
    ).resolves.toMatchObject({ status: "rejected" });
    await expect(
      client.ai.send({ threadId: "s1", runId: "run-q", messages: [message] })
    ).resolves.toMatchObject({ status: "queued" });
    expect(await drainNow(stream)).toEqual([]);
    await stream.return?.(undefined);
  });

  it("resumes after lastEventId from the notice ring, across threads", async () => {
    const { client, emit, boot } = setup();
    boot("s1");
    boot("s2");
    const finish = (threadId: string, runId: string) => {
      emit(threadId, { type: "RUN_STARTED", threadId, runId });
      emit(threadId, {
        type: "RUN_FINISHED",
        threadId,
        runId,
        outcome: { type: "success" },
      });
    };
    const first = await client.ai.runFinished({});
    finish("s1", "run-1");
    const [seen] = await read(first, 1);
    await first.return?.(undefined);

    // Missed while disconnected.
    finish("s2", "run-2");
    finish("s1", "run-3");

    const resumed = await client.ai.runFinished({ lastEventId: seen!.id });
    const replay = await read(resumed, 2);
    expect(replay.map((entry) => entry.notice.runId)).toEqual([
      "run-2",
      "run-3",
    ]);
    expect(Number(replay[0]!.id)).toBeGreaterThan(Number(seen!.id));
    await resumed.return?.(undefined);

    // Without a resume point nothing is replayed.
    const fresh = await client.ai.runFinished({});
    expect(await drainNow(fresh)).toEqual([]);
    await fresh.return?.(undefined);
    expect(NOTICES_KEPT).toBeGreaterThanOrEqual(1_000);
  });
});
