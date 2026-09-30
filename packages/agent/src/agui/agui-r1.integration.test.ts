/**
 * The implementation review round 1 fixes, live against the real session and
 * the fake provider (reviews/00-agent-agui.impl-fixes-r1.md): admission held
 * through Stop and reset, preparation failures, token-owned failures, the
 * run envelope, retries through a continuous processor, token release after
 * an aborted send, and the order of a permission's resolution.
 */
import { StreamProcessor } from "@tanstack/ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { stopProvider } from "./__tests__/harness.js";
import { violations } from "./__tests__/invariants.js";
import {
  hasCustom,
  hasType,
  latestPending,
  live,
  runInput,
  type Live,
} from "./__tests__/live.js";
import type { AguiEvent, PermissionDescriptor } from "./wire.js";

let open: Live[] = [];

async function start(options: Parameters<typeof live>[0]): Promise<Live> {
  const l = await live(options);

  open.push(l);

  return l;
}

afterEach(async () => {
  for (const l of open) {
    for (const name of ["first", "reset", "stop", "late", "second", "hold"]) {
      l.gates.open(name);
    }
    await l.close();
  }
  open = [];
});

afterAll(async () => {
  await stopProvider();
});

const names = (events: AguiEvent[]): string[] =>
  events.map((event) => (event.type === "CUSTOM" ? event.name : event.type));

const ackOf = (l: Live, runId: string) =>
  l
    .custom<{
      runId: string;
      status: string;
      reason?: string;
      waitingFor?: string;
    }>("run.ack")
    .find((value) => value.runId === runId);

/** Lets the host's pending microtasks and timers run. */
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a retry reusing its user message id (Codex r1 #2)", () => {
  it("leaves the text once in a processor that saw both runs", async () => {
    const l = await start({
      reply: (index) =>
        index === 0
          ? { fail: { status: 400, message: "nope" } }
          : { say: "answered" },
    });
    const run = (runId: string) => ({
      type: "run",
      input: {
        threadId: "t-1",
        runId,
        messages: [{ id: "u-same", role: "user", content: "question" }],
        tools: [],
        context: [],
        state: {},
      },
    });

    l.send(run("a"));
    await l.waitFor(hasType("RUN_ERROR"), "failed run");
    l.send(run("b"));
    await l.waitFor(hasType("RUN_FINISHED"), "retried run");

    // Main's transcript processor and a subscribed second window see every
    // event of both runs, in order.
    const processor = new StreamProcessor();

    for (const event of l.events()) processor.processChunk(event as never);
    const user = processor
      .getMessages()
      .filter((message) => message.role === "user");

    expect(user).toHaveLength(1);
    expect(
      user[0]!.parts
        .filter((part) => part.type === "text")
        .map((part) => (part as { content: string }).content)
    ).toEqual(["question"]);
    expect(l.providerCalls()).toBe(2);
  });
});

describe("a preparation that throws (Codex r1 #3, Claude r1 #1)", () => {
  it("reports it as non-terminal, prompts anyway, and leaves the host usable", async () => {
    const l = await start({
      reply: (index) => ({ say: `answer ${index}` }),
      wrap: (session) => {
        session.setModel = async () => {
          throw new Error("no key for that model");
        };

        return session;
      },
    });

    l.send(
      runInput("p1", "hello", { forwardedProps: { model: "fake/other" } })
    );
    await l.waitFor(hasType("RUN_FINISHED"), "the run finished");
    expect(l.custom("agent.error")).toEqual([
      { message: "no key for that model" },
    ]);
    const finished = l
      .events()
      .find((event) => event.type === "RUN_FINISHED") as {
      runId: string;
      outcome: { type: string };
    };

    expect(finished).toMatchObject({
      runId: "p1",
      outcome: { type: "success" },
    });
    // The compat line is the legacy one for a failed set_model.
    expect(l.compatBytes()).toContain(
      '{"type":"event","event":{"type":"error","error":{"message":"no key for that model"}}}\n'
    );

    // Neither busy nor preparing is left held: the next turns run.
    l.send({ type: "send", message: "legacy after" });
    await l.waitFor(hasType("RUN_FINISHED", 2), "legacy send ran");
    l.send(runInput("p2", "client after"));
    await l.waitFor(hasType("RUN_FINISHED", 3), "second run ran");
    expect(l.providerCalls()).toBe(3);
    expect(violations(l.events())).toEqual([]);
  });
});

describe("admission held through an idle reset or Stop (Codex r1 #4)", () => {
  it("queues every turn starter behind a reset still landing, then runs them in the new conversation", async () => {
    let holder: Live | undefined;
    const l = await start({
      reply: (index) => ({ say: `answer ${index}` }),
      wrap: (session) => {
        const original = session.resetConversation.bind(session);

        session.resetConversation = async () => {
          await holder!.gates.wait("reset");

          return original();
        };

        return session;
      },
    });

    holder = l;
    l.send({ type: "reset_conversation" });
    await settle(50);
    l.send(runInput("r1", "run during reset"));
    l.send({ type: "send", message: "send during reset" });
    l.send({ type: "enqueue", message: "enqueue during reset", hidden: false });
    l.send({ type: "dequeue" });
    await l.waitFor(() => ackOf(l, "r1") != null, "run ack");
    await settle();

    // Nothing reached the session being replaced.
    expect(l.providerCalls()).toBe(0);
    expect(l.events().some((event) => event.type === "RUN_STARTED")).toBe(
      false
    );
    expect(ackOf(l, "r1")).toMatchObject({
      status: "queued",
      waitingFor: "turn",
    });
    const queued = l
      .custom<{ messages: Array<{ message: string; waitingFor: string }> }>(
        "queue.updated"
      )
      .at(-1)?.messages;

    expect(queued).toEqual([
      { id: "q-1", message: "run during reset", waitingFor: "turn" },
      { id: "q-2", message: "send during reset", waitingFor: "turn" },
      { id: "q-3", message: "enqueue during reset", waitingFor: "turn" },
    ]);

    l.gates.open("reset");
    // Everything queued runs after the reset landed, in order, one run each.
    await l.waitFor(hasType("RUN_FINISHED", 3), "all three ran");
    expect(l.providerCalls()).toBe(3);
    expect(names(l.events()).indexOf("session.cleared")).toBeLessThan(
      names(l.events()).indexOf("RUN_STARTED")
    );
    const userTexts = l
      .events()
      .filter(
        (event) =>
          event.type === "TEXT_MESSAGE_CONTENT" &&
          (event as { messageId: string }).messageId.endsWith(":user")
      )
      .map((event) => (event as { delta: string }).delta);

    expect(userTexts).toEqual([
      "run during reset",
      "send during reset",
      "enqueue during reset",
    ]);
    expect(violations(l.events())).toEqual([]);
  });

  it("queues a run that lands while an idle Stop is still aborting", async () => {
    let holder: Live | undefined;
    const l = await start({
      reply: (index) => ({ say: `answer ${index}` }),
      wrap: (session) => {
        const original = session.stop.bind(session);

        session.stop = async () => {
          await holder!.gates.wait("stop");

          return original();
        };

        return session;
      },
    });

    holder = l;
    l.send({ type: "stop" });
    await settle(50);
    l.send(runInput("s1", "run during stop"));
    await l.waitFor(() => ackOf(l, "s1") != null, "run ack");
    await settle();
    expect(ackOf(l, "s1")).toMatchObject({
      status: "queued",
      waitingFor: "turn",
    });
    expect(l.providerCalls()).toBe(0);

    l.gates.open("stop");
    // runAfterStop starts it once the abort has landed.
    await l.waitFor(hasType("RUN_FINISHED"), "ran after the stop");
    expect(l.providerCalls()).toBe(1);
    expect(violations(l.events())).toEqual([]);
  });
});

describe("failures belong to the token that threw (Codex r1 #5, Claude r1 #8)", () => {
  it("a send that throws ends its own run in RUN_ERROR, never success then a stray error", async () => {
    const l = await start({
      reply: () => ({ say: "never" }),
      wrap: (session) => {
        session.send = async () => {
          throw new Error("the session fell over");
        };

        return session;
      },
    });

    l.send(runInput("t1", "hi"));
    await l.waitFor(hasType("RUN_ERROR"), "terminal");
    await settle();

    const terminals = l
      .events()
      .filter(
        (event) => event.type === "RUN_ERROR" || event.type === "RUN_FINISHED"
      );

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      type: "RUN_ERROR",
      message: "the session fell over",
      metadata: { tanstack: { runId: "t1" } },
    });
    // Reported once: as the terminal, not again as agent.error.
    expect(l.custom("agent.error")).toEqual([]);
    // Compat keeps the legacy thrown-handler line.
    expect(l.compatBytes()).toContain(
      '{"type":"event","event":{"type":"error","error":{"message":"the session fell over"}}}\n'
    );
  });

  it("a queued command's steering failure never fails the run that is open", async () => {
    const l = await start({
      reply: (index, gates) =>
        index === 0
          ? gates.wait("first").then(() => ({ say: "A done" }))
          : { say: "B" },
      wrap: (session) => {
        session.steer = async () => {
          throw new Error("steer refused");
        };

        return session;
      },
    });

    l.send(runInput("a", "first"));
    await l.waitFor(() => l.providerCalls() === 1, "a streaming");
    l.send({ type: "send", message: "second" });
    await l.waitFor(hasCustom("agent.error"), "steer failure reported");
    l.gates.open("first");
    await l.waitFor(hasType("RUN_FINISHED"), "a finished");

    expect(l.custom("agent.error")).toEqual([{ message: "steer refused" }]);
    const terminal = l
      .events()
      .find(
        (event) => event.type === "RUN_FINISHED" || event.type === "RUN_ERROR"
      ) as { type: string; runId?: string };

    expect(terminal).toMatchObject({ type: "RUN_FINISHED", runId: "a" });
  });
});

describe("the run envelope (Codex r1 #7, Claude r1 #12)", () => {
  it("rejects a foreign thread, a foreign conversation and any resume before touching anything", async () => {
    const l = await start({ reply: () => ({ say: "ok" }) });
    const compatBefore = l.compatBytes();
    const modeBefore = l.host.emitter.agentState().mode;

    l.send(runInput("x1", "hi", { threadId: "t-other" }));
    l.send(
      runInput("x2", "hi", {
        forwardedProps: { conversationId: "t-other", mode: "yolo" },
      })
    );
    l.send(runInput("x3", "hi", { resume: { interruptId: "i", status: "x" } }));
    l.send(runInput("x4", "hi", { resume: "yes" }));
    await l.waitFor(hasCustom("run.ack", 4), "acks");

    expect(l.custom("run.ack")).toEqual([
      { runId: "x1", status: "rejected", reason: "thread_mismatch" },
      { runId: "x2", status: "rejected", reason: "thread_mismatch" },
      { runId: "x3", status: "rejected", reason: "resume_unsupported" },
      { runId: "x4", status: "rejected", reason: "resume_unsupported" },
    ]);
    await settle();
    expect(l.compatBytes()).toBe(compatBefore);
    expect(l.host.emitter.agentState().mode).toBe(modeBefore);
    expect(l.providerCalls()).toBe(0);

    // A foreign-thread run id was never recorded: the right thread may use it.
    l.send(runInput("x1", "hi"));
    await l.waitFor(hasType("RUN_FINISHED"), "accepted");
    expect(ackOf(l, "x1")).toBeDefined();
    expect(l.custom("run.ack").at(-1)).toEqual({
      runId: "x1",
      status: "started",
    });
  });
});

describe("an aborted send resolving late (Claude r1 #7)", () => {
  it("does not clear the newer send's token, so its permissions keep their turn", async () => {
    let holder: Live | undefined;
    let sends = 0;
    const l = await start({
      reply: (index, gates) =>
        index === 0
          ? { stall: { say: "slow" } }
          : index === 1
            ? gates.wait("second").then(() => ({
                call: {
                  name: "write",
                  args: { path: "late.txt", content: "x\n" },
                },
              }))
            : { say: "understood" },
      wrap: (session) => {
        const original = session.send.bind(session);

        session.send = async (text, turn) => {
          const mine = ++sends;

          await original(text, turn);
          // The first (aborted) send returns only after the next one began.
          if (mine === 1) await holder!.gates.wait("late");
        };

        return session;
      },
    });

    holder = l;
    l.send({ type: "send", message: "first" });
    await l.waitFor(() => l.providerCalls() === 1, "first streaming");
    l.send({ type: "stop" });
    l.send({ type: "send", message: "second" });
    await l.waitFor(() => l.providerCalls() === 2, "second streaming");
    // The aborted send's finally runs now, while the second send is current.
    l.gates.open("late");
    await settle();
    l.gates.open("second");
    await l.waitFor(hasCustom("permission.requested"), "permission");

    const [descriptor] = latestPending(l) as [PermissionDescriptor];

    expect(descriptor.metadata.abacus.lineage.turnSeq).toBeGreaterThan(0);
    l.send({
      type: "permission.respond",
      lineage: descriptor.metadata.abacus.lineage,
      decision: "reject",
    });
    await l.waitFor(hasCustom("permission.resolved"), "answered");
  });
});

describe("a permission's resolution (Claude r1 #9)", () => {
  it("goes out before what the answer releases, parked steers included", async () => {
    const l = await start({
      reply: (index) =>
        index === 0
          ? { call: { name: "write", args: { path: "o.txt", content: "o\n" } } }
          : { say: "done" },
    });

    l.send(runInput("r", "write it"));
    await l.waitFor(hasCustom("permission.requested"), "permission");
    // Parked behind the card.
    l.send({ type: "enqueue", message: "after the card", hidden: false });
    await l.waitFor(
      (events) =>
        l
          .custom<{ messages: Array<{ waitingFor: string }> }>("queue.updated")
          .at(-1)?.messages[0]?.waitingFor === "permission" &&
        events.length > 0,
      "parked"
    );
    const [descriptor] = latestPending(l) as [PermissionDescriptor];
    const from = l.events().length;

    l.send({
      type: "permission.respond",
      lineage: descriptor.metadata.abacus.lineage,
      decision: "accept",
    });
    await l.waitFor(hasType("RUN_FINISHED"), "done");

    const after = names(l.events().slice(from));

    expect(after.slice(0, 2)).toEqual([
      "permission.resolved",
      "permission.pending",
    ]);
    expect(after.indexOf("permission.resolved")).toBeLessThan(
      after.indexOf("queue.updated")
    );
    expect(after.indexOf("permission.resolved")).toBeLessThan(
      after.indexOf("TOOL_CALL_RESULT")
    );
  });
});
