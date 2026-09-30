/**
 * The `--wire agui` host, live against the fake provider (spec §7.5, §7.6):
 * admission, cancel, permission lineage, ChatClient round trips, sub-agents,
 * and the compat channel's loss path.
 */
import { PassThrough } from "node:stream";

import { StreamProcessor } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { AbacusBotSession } from "../session.js";
import { hostAdapter } from "./__tests__/chat-adapter.js";
import { lines, prepare, stopProvider } from "./__tests__/harness.js";
import { violations } from "./__tests__/invariants.js";
import {
  hasCustom,
  hasType,
  latestPending,
  live,
  runInput,
  type Live,
} from "./__tests__/live.js";
import { streamWriter } from "./channel.js";
import { AguiHost } from "./host.js";
import type { AguiEvent, PermissionDescriptor } from "./wire.js";

let open: Live[] = [];

async function start(options: Parameters<typeof live>[0]): Promise<Live> {
  const l = await live(options);

  open.push(l);

  return l;
}

afterEach(async () => {
  for (const l of open) {
    // Release anything a responder is holding so stdin EOF can settle.
    for (const name of ["first", "model", "hold"]) l.gates.open(name);
    await l.close();
  }
  open = [];
});

afterAll(async () => {
  await stopProvider();
});

const writeCall = (path: string) => ({
  call: { name: "write", args: { path, content: `${path}\n` } },
});

const ack = (l: Live, runId: string) =>
  l
    .custom<{
      runId: string;
      status: string;
      reason?: string;
      waitingFor?: string;
    }>("run.ack")
    .find((value) => value.runId === runId);

describe("admission", () => {
  it("acks duplicate, empty and resume runs without a run or a compat byte", async () => {
    const l = await start({ reply: () => ({ say: "ok" }) });

    l.send(runInput("r1", "hi"));
    await l.waitFor(hasType("RUN_FINISHED"), "first run");
    const before = l.compatBytes();

    l.send(runInput("r1", "hi"));
    l.send(runInput("r2", "   "));
    l.send(
      runInput("r3", "hi", {
        resume: [{ interruptId: "x", status: "resolved" }],
      })
    );
    await l.waitFor(hasCustom("run.ack", 4), "acks");

    expect(ack(l, "r1")?.status).toBe("started");
    expect(
      l.custom<{ status: string; reason?: string }>("run.ack").slice(1)
    ).toEqual([
      { runId: "r1", status: "duplicate" },
      { runId: "r2", status: "rejected", reason: "empty" },
      { runId: "r3", status: "rejected", reason: "resume_unsupported" },
    ]);
    expect(l.compatBytes()).toBe(before);
    expect(
      l.events().filter((event) => event.type === "RUN_STARTED")
    ).toHaveLength(1);
  });

  it("queues a run that lands while busy, as the legacy send would, and opens no run", async () => {
    const l = await start({
      reply: (index, gates) =>
        index === 0
          ? gates.wait("first").then(() => ({ say: "one" }))
          : { say: "two" },
    });

    l.send(runInput("a", "first"));
    await l.waitFor(() => l.providerCalls() === 1, "first request");
    l.send(runInput("b", "second"));
    await l.waitFor(
      (events) => ack(l, "b") != null && events.length > 0,
      "queued ack"
    );

    expect(ack(l, "b")).toMatchObject({ status: "queued", waitingFor: "step" });
    expect(
      l.events().filter((event) => event.type === "RUN_STARTED")
    ).toHaveLength(1);

    l.gates.open("first");
    await l.waitFor(hasType("RUN_FINISHED"), "run a finished");
    expect(violations(l.events())).toEqual([]);
  });

  it("rejects regenerating a successful answer, and re-prompts a retry after an error", async () => {
    const l = await start({
      reply: (index) =>
        index === 0
          ? { fail: { status: 400, message: "nope" } }
          : { say: `answer ${index}` },
    });
    const message = (runId: string, intent?: string) => ({
      type: "run",
      input: {
        threadId: "t-1",
        runId,
        messages: [{ id: "u-same", role: "user", content: "question" }],
        tools: [],
        context: [],
        state: {},
        ...(intent != null ? { forwardedProps: { intent } } : {}),
      },
    });

    l.send(message("e1"));
    await l.waitFor(hasType("RUN_ERROR"), "failed run");
    l.send(message("e2", "regenerate"));
    await l.waitFor(hasType("RUN_FINISHED"), "retried run");
    expect(ack(l, "e2")?.status).toBe("started");

    l.send(message("e3", "regenerate"));
    await l.waitFor(() => ack(l, "e3") != null, "regenerate ack");
    expect(ack(l, "e3")).toMatchObject({
      status: "rejected",
      reason: "regenerate_unsupported",
    });
  });

  it("never prompts a run stopped while its model is still being applied", async () => {
    const l = await start({
      reply: () => ({ say: "should not happen" }),
      wrap: (session) => {
        const original = session.setModel.bind(session);

        session.setModel = async (model) => {
          await l0.gates.wait("model");

          return original(model);
        };

        return session;
      },
    });
    const l0 = l;

    l.send(
      runInput("p1", "hello", { forwardedProps: { model: "fake/other" } })
    );
    await l.waitFor(hasType("RUN_STARTED"), "admitted");
    l.send({ type: "send", message: "legacy while preparing" });
    await l.waitFor(hasCustom("queue.updated"), "legacy send queued");
    expect(
      l
        .custom<{ messages: Array<{ waitingFor: string }> }>("queue.updated")
        .at(-1)?.messages[0]?.waitingFor
    ).toBe("turn");

    l.send({ type: "cancel", runId: "p1" });
    await l.waitFor(hasType("RUN_FINISHED"), "cancelled terminal");
    const finished = l
      .events()
      .find((event) => event.type === "RUN_FINISHED") as {
      runId: string;
      outcome: { type: string };
    };

    expect(finished).toMatchObject({
      runId: "p1",
      outcome: { type: "cancelled" },
    });

    l.gates.open("model");
    // The queued legacy send runs next as its own turn; the stopped prompt never does.
    await l.waitFor(hasType("RUN_FINISHED", 2), "the queued send ran");
    expect(l.providerCalls()).toBe(1);
  });

  it("never prompts into a conversation reset during preparation", async () => {
    let gateHolder: Live | undefined;
    const l = await start({
      reply: () => ({ say: "should not happen" }),
      wrap: (session) => {
        const original = session.setModel.bind(session);

        session.setModel = async (model) => {
          await gateHolder!.gates.wait("model");

          return original(model);
        };

        return session;
      },
    });

    gateHolder = l;
    l.send(
      runInput("p2", "hello", { forwardedProps: { model: "fake/other" } })
    );
    await l.waitFor(hasType("RUN_STARTED"), "admitted");
    l.send({ type: "reset_conversation" });
    await l.waitFor(hasCustom("session.cleared"), "reset");
    l.gates.open("model");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(l.providerCalls()).toBe(0);
    const terminal = l
      .events()
      .filter((event) => event.type === "RUN_FINISHED");

    expect(terminal).toHaveLength(1);
    expect((terminal[0] as { outcome: { type: string } }).outcome.type).toBe(
      "cancelled"
    );
    const types = l
      .events()
      .map((event) => (event.type === "CUSTOM" ? event.name : event.type));

    expect(types.indexOf("RUN_FINISHED")).toBeLessThan(
      types.indexOf("session.cleared")
    );
  });
});

describe("cancel", () => {
  it("ignores a late cancel for a run that already ended", async () => {
    const l = await start({
      reply: (index, gates) =>
        index === 0
          ? { say: "a" }
          : gates.wait("hold").then(() => ({ say: "b" })),
    });

    l.send(runInput("A", "one"));
    await l.waitFor(hasType("RUN_FINISHED"), "A done");
    l.send(runInput("B", "two"));
    await l.waitFor(() => l.providerCalls() === 2, "B streaming");
    l.send({ type: "cancel", runId: "A" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(
      l.events().filter((event) => event.type === "RUN_FINISHED")
    ).toHaveLength(1);

    l.gates.open("hold");
    await l.waitFor(hasType("RUN_FINISHED", 2), "B done");
    const last = l
      .events()
      .filter((event) => event.type === "RUN_FINISHED")
      .at(-1) as {
      runId: string;
      outcome: { type: string };
    };

    expect(last).toMatchObject({ runId: "B", outcome: { type: "success" } });
  });
});

describe("permissions", () => {
  it("rejects stale, foreign and invalid answers without releasing anything, then applies a valid one", async () => {
    const l = await start({
      reply: (index) => (index === 0 ? writeCall("a.txt") : { say: "done" }),
    });

    l.send(runInput("r", "write it"));
    await l.waitFor(hasCustom("permission.requested"), "permission");
    const [descriptor] = latestPending(l) as [PermissionDescriptor];
    const lineage = descriptor.metadata.abacus.lineage;
    const compatBefore = l.compatBytes();
    const respond = (overrides: object, decision: unknown = "accept") =>
      l.send({
        type: "permission.respond",
        lineage: { ...lineage, ...overrides },
        decision,
      });

    respond({ incarnation: "old-process" });
    respond({ threadId: "t-other" });
    respond({ turnSeq: lineage.turnSeq + 7 });
    respond({ permissionId: "perm-99" });
    respond({}, true);
    respond({}, { approved: true });
    respond({}, "background");
    await l.waitFor(hasCustom("permission.response_rejected", 7), "rejections");

    expect(
      l
        .custom<{ reason: string }>("permission.response_rejected")
        .map((value) => value.reason)
    ).toEqual([
      "incarnation",
      "thread",
      "turn",
      "not_pending",
      "invalid_decision",
      "invalid_decision",
      "decision_not_allowed",
    ]);
    expect(l.compatBytes()).toBe(compatBefore);
    expect(latestPending(l).map((item) => item.id)).toEqual(["perm-1"]);

    respond({});
    await l.waitFor(hasType("RUN_FINISHED"), "run finished");
    expect(l.custom("permission.resolved")).toEqual([
      { permissionId: "perm-1", decisionKind: "accept", source: "respond" },
    ]);
    // Same compat effect as the legacy permission_response: the queue line.
    expect(l.compatBytes().slice(compatBefore.length)).toContain(
      '"type":"queue_updated"'
    );
    expect(violations(l.events())).toEqual([]);
  });

  it("a replacement process rejects the old process's perm-1 even with its own perm-1 pending", async () => {
    const l = await start({
      incarnation: "inc-new",
      reply: (index) => (index === 0 ? writeCall("b.txt") : { say: "done" }),
    });

    l.send(runInput("r", "write"));
    await l.waitFor(hasCustom("permission.requested"), "permission");
    const [own] = latestPending(l) as [PermissionDescriptor];

    l.send({
      type: "permission.respond",
      lineage: { ...own.metadata.abacus.lineage, incarnation: "inc-old" },
      decision: "accept",
    });
    await l.waitFor(hasCustom("permission.response_rejected"), "rejected");
    expect(latestPending(l).map((item) => item.id)).toEqual(["perm-1"]);

    l.send({
      type: "permission.respond",
      lineage: own.metadata.abacus.lineage,
      decision: "reject",
    });
    await l.waitFor(hasType("RUN_FINISHED"), "done");
    const result = l
      .events()
      .find((event) => event.type === "TOOL_CALL_RESULT") as {
      metadata?: { tanstack?: { state: string; toolResultOutcome?: string } };
    };

    expect(result.metadata?.tanstack).toEqual({
      state: "output-error",
      toolResultOutcome: "denied",
    });
  });

  it("expires one permission while the other stays answerable", async () => {
    const l = await start({
      env: { ABACUSAI_BOT_APPROVAL_TIMEOUT_MS: "150" },
      reply: (index) => (index === 0 ? writeCall("c.txt") : { say: "done" }),
    });

    l.send(runInput("r", "write"));
    await l.waitFor(hasCustom("permission.cleared"), "expiry");
    const cleared = l.custom<{ reason: string }>("permission.cleared");

    expect(cleared[0]?.reason).toBe("expired");
    await l.waitFor(hasType("RUN_FINISHED"), "done");
    const result = l
      .events()
      .find((event) => event.type === "TOOL_CALL_RESULT") as {
      metadata?: { tanstack?: { toolResultOutcome?: string } };
    };

    expect(result.metadata?.tanstack?.toolResultOutcome).toBe("denied");
  });

  it("clears pending permissions on Stop and closes the call as cancelled", async () => {
    const l = await start({ reply: () => writeCall("d.txt") });

    l.send(runInput("r", "write"));
    await l.waitFor(hasCustom("permission.requested"), "permission");
    l.send({ type: "cancel" });
    await l.waitFor(hasType("RUN_FINISHED"), "stopped");

    expect(l.custom<{ reason: string }>("permission.cleared")[0]?.reason).toBe(
      "stopped"
    );
    expect(latestPending(l)).toEqual([]);
    const result = l
      .events()
      .find((event) => event.type === "TOOL_CALL_RESULT") as {
      metadata?: { tanstack?: { toolResultOutcome?: string } };
    };

    expect(result.metadata?.tanstack?.toolResultOutcome).toBe("cancelled");
    expect(violations(l.events())).toEqual([]);
  });
});

describe("ChatClient", () => {
  it("send → permission → respond → RUN_FINISHED, with native interrupts left empty", async () => {
    const l = await start({
      reply: (index) =>
        index === 0 ? writeCall("e.txt") : { say: "Wrote it." },
    });
    const customs: string[] = [];
    const chat = new ChatClient({
      connection: hostAdapter(l),
      threadId: "t-1",
      queue: { whenBusy: "drop" },
      onCustomEvent: (name) => customs.push(name),
    });

    const sent = chat.sendMessage("write e");

    await l.waitFor(hasCustom("permission.requested"), "permission");
    expect(chat.getIsLoading()).toBe(true);
    expect(chat.getInterrupts()).toEqual([]);

    const [descriptor] = latestPending(l) as [PermissionDescriptor];

    l.send({
      type: "permission.respond",
      lineage: descriptor.metadata.abacus.lineage,
      decision: "accept",
    });
    await sent;

    expect(chat.getIsLoading()).toBe(false);
    expect(customs).toContain("permission.requested");
    // The run's user message on stdout reuses the client's id: no duplicate.
    expect(
      chat.getMessages().filter((message) => message.role === "user")
    ).toHaveLength(1);
    const assistant = chat
      .getMessages()
      .filter((message) => message.role === "assistant");
    const parts = assistant.flatMap((message) =>
      message.parts.map((part) => part.type)
    );

    expect(parts).toEqual(expect.arrayContaining(["tool-call", "text"]));
    const text = assistant
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => (part as { content: string }).content)
      .join("");

    expect(text).toContain("Wrote it.");
  });

  it("a raced run settles on the injected queued terminal before the other run ends", async () => {
    const l = await start({
      reply: (index, gates) =>
        index === 0
          ? gates.wait("first").then(() => ({ say: "A done" }))
          : { say: "B done" },
    });
    const a = new ChatClient({
      connection: hostAdapter(l),
      threadId: "t-1",
      queue: { whenBusy: "drop" },
    });
    const b = new ChatClient({
      connection: hostAdapter(l),
      threadId: "t-1",
      queue: { whenBusy: "drop" },
    });

    const sentA = a.sendMessage("from window A");

    await l.waitFor(() => l.providerCalls() === 1, "A streaming");
    const errors: string[] = [];
    const sentB = b
      .sendMessage("from window B")
      .catch((error: Error) => errors.push(error.message));

    await sentB;
    // A's run is still open: B settled on its own terminal first.
    expect(
      l.events().filter((event) => event.type === "RUN_FINISHED")
    ).toHaveLength(0);
    expect(b.getIsLoading()).toBe(false);
    expect(
      l.custom<{ status: string }>("run.ack").map((value) => value.status)
    ).toEqual(["started", "queued"]);

    l.gates.open("first");
    await sentA;
    // Today's send-while-busy: B's text was steered into A's turn at the next
    // step, as a user message inside A's run.
    expect(l.custom("queue.steered")).toEqual([{ content: "from window B" }]);
    expect(
      l.events().filter((event) => event.type === "RUN_FINISHED")
    ).toHaveLength(1);
    expect(violations(l.events())).toEqual([]);
  });
});

describe("sub-agents", () => {
  it("tags a delegate's events and closes its card before the parent's result", async () => {
    const l = await start({
      mode: "yolo",
      reply: (index) =>
        index === 0
          ? {
              call: {
                name: "delegate_task",
                args: { task: "find the answer" },
              },
            }
          : index === 1
            ? { say: "The answer is 42." }
            : { say: "It is 42." },
    });

    l.send(runInput("r", "delegate it"));
    await l.waitFor(hasType("RUN_FINISHED"), "done");

    const events = l.events();

    expect(violations(events)).toEqual([]);
    const started = events.find(
      (event) => event.type === "SUBAGENT_STARTED"
    ) as {
      subagentRunId: string;
      parentToolCallId?: string;
      name: string;
    };

    expect(started).toMatchObject({
      name: "delegate",
      parentToolCallId: "call-0-0",
    });
    const childText = events.filter(
      (event) =>
        event.type === "TEXT_MESSAGE_CONTENT" &&
        (event as { subagentRunId?: string }).subagentRunId ===
          started.subagentRunId
    );

    expect(
      childText.map((event) => (event as { delta: string }).delta).join("")
    ).toBe("The answer is 42.");
    const order: string[] = events.map((event) => event.type);

    expect(order.indexOf("SUBAGENT_FINISHED")).toBeLessThan(
      order.indexOf("TOOL_CALL_RESULT")
    );

    const processor = new StreamProcessor();

    for (const event of events) processor.processChunk(event as never);
    const card = processor
      .getMessages()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "subagent") as {
      subagent: {
        status: string;
        parentToolCallId?: string;
        messages: Array<{ parts: Array<{ type: string }> }>;
      };
    };

    expect(card.subagent.status).toBe("finished");
    expect(card.subagent.parentToolCallId).toBe("call-0-0");
    expect(
      card.subagent.messages.flatMap((m) => m.parts.map((p) => p.type))
    ).toContain("text");
  });
});

describe("compat channel loss", () => {
  it("says so on stdout, fails the open run, and exits 75", async () => {
    const { context, gates, restore } = await prepare({
      name: "loss",
      reply: (_index, g) => g.wait("hold").then(() => ({ say: "x" })),
      steps: [],
    });
    const stdin = new PassThrough();
    const fd3 = new PassThrough();
    let stdout = "";
    const exits: number[] = [];
    let host: AguiHost | undefined;
    const compat = streamWriter(fd3, (error) => host?.compatLost(error));

    host = new AguiHost({
      cwd: context.cwd,
      threadId: "t-1",
      incarnation: "inc-1",
      compat,
      stdin,
      writeStdout: (text) => {
        stdout += text;
      },
      exit: (code) => exits.push(code),
      log: () => undefined,
      session: (init) => new AbacusBotSession(init),
    });
    const done = host.run();
    const events = (): AguiEvent[] =>
      lines(stdout).map((line) => JSON.parse(line) as AguiEvent);
    const deadline = Date.now() + 20_000;

    stdin.write(`${JSON.stringify(runInput("r", "hi"))}\n`);
    while (
      !events().some((event) => event.type === "RUN_STARTED") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fd3.emit("error", new Error("EPIPE"));
    const after = events().length;

    expect(exits).toEqual([75]);
    const tail = events().slice(after - 2);

    expect(
      tail.map((event) => (event.type === "CUSTOM" ? event.name : event.type))
    ).toEqual(["wire.compat_lost", "RUN_ERROR"]);
    expect((tail[1] as { code?: string }).code).toBe("compat_lost");

    // Nothing more reaches stdout afterwards.
    gates.open("hold");
    stdin.end();
    await done;
    expect(events()).toHaveLength(after);
    restore();
  });
});

describe("last words", () => {
  it("emergencyClose writes one RUN_ERROR for an open run, synchronously and once", async () => {
    const l = await start({
      reply: (_i, gates) => gates.wait("hold").then(() => ({ say: "x" })),
    });
    const written: string[] = [];

    l.send(runInput("r", "hi"));
    await l.waitFor(hasType("RUN_STARTED"), "started");

    // What main.ts wires to process.on("exit").
    (
      l.host as unknown as {
        options: { writeStdoutSync?: (t: string) => void };
      }
    ).options.writeStdoutSync = (text) => written.push(text);
    l.host.emergencyClose("agent_crashed");
    l.host.emergencyClose("agent_exit");

    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!)).toMatchObject({
      type: "RUN_ERROR",
      code: "agent_crashed",
    });
  });
});
