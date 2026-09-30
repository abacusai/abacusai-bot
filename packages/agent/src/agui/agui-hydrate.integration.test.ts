/**
 * Hydration (spec §5.3, §7.8): a window that attaches mid-run, through
 * TanStack's own `hydrate` + `joinRun` over main's relay, ends with the same
 * parts as a client that watched the run live. The agent's side of the
 * contract is that stdout alone carries everything needed.
 */
import { EventType } from "@ag-ui/core";
import { StreamProcessor, type UIMessage } from "@tanstack/ai";
import {
  ChatClient,
  type SubscribeConnectionAdapter,
} from "@tanstack/ai-client";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { stopProvider } from "./__tests__/harness.js";
import { hasType, live, runInput, type Live } from "./__tests__/live.js";
import { Relay } from "./__tests__/relay.js";
import { aguiEvent, custom } from "./event.js";
import type { AguiEvent } from "./wire.js";

let opened: Live[] = [];

afterEach(async () => {
  for (const l of opened) {
    l.gates.open("final");
    // A stalled reply only ends when the turn is stopped.
    l.send({ type: "stop" });
    await l.close();
  }
  opened = [];
});

afterAll(async () => {
  await stopProvider();
});

/** A window restored from the relay: hydrate, then joinRun. */
function restoredClient(relay: Relay): ChatClient {
  const connection: SubscribeConnectionAdapter = {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
    send: async () => undefined,
    hydrate: async () => relay.hydrate(),
    joinRun: (runId, signal) => relay.joinRun(runId, signal) as never,
  };

  const client = new ChatClient({
    connection,
    threadId: "t-1",
    persistence: true,
  });

  // What a UI wrapper does on mount: hydrate, then rejoin the active run.
  client.attach();

  return client;
}

/** Parts without volatile fields, for comparing two clients. */
function shape(messages: UIMessage[]): unknown {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    parts: message.parts.map((part) => {
      const rest = { ...(part as unknown as Record<string, unknown>) };

      if (part.type === "subagent") {
        const subagent = (
          part as {
            subagent: { id: string; status: string; messages: UIMessage[] };
          }
        ).subagent;

        return {
          type: "subagent",
          id: subagent.id,
          status: subagent.status,
          messages: shape(subagent.messages),
        };
      }

      delete rest.createdAt;
      delete rest.metadata;

      return rest;
    }),
  }));
}

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("reload mid-run", () => {
  it("restores a finished tool, a finished child and streamed text, then follows live", async () => {
    const relay = new Relay();
    const l = await live({
      mode: "yolo",
      reply: (index, gates) =>
        index === 0
          ? {
              say: "Let me look.",
              calls: [
                { name: "bash", args: { command: "echo hydrated" } },
                { name: "delegate_task", args: { task: "find it" } },
              ],
            }
          : index === 1
            ? { say: "Child found it." }
            : gates.wait("final").then(() => ({ say: "Both done." })),
    });

    opened.push(l);
    for (const event of l.events()) relay.ingest(event);
    l.onEvent((event) => relay.ingest(event));

    l.send(runInput("r1", "go"));
    await l.waitFor(
      (events) =>
        events.some((event) => event.type === "SUBAGENT_FINISHED") &&
        events.filter((event) => event.type === "TOOL_CALL_RESULT").length >= 2,
      "tool and child finished"
    );

    const restored = restoredClient(relay);

    await until(() => restored.getMessages().length > 0, "restored replay");
    l.gates.open("final");
    await l.waitFor(hasType("RUN_FINISHED"), "run finished");
    await until(() => !restored.getIsLoading(), "restored client settled");

    const watched = shape(relay.messages());

    expect(shape(restored.getMessages())).toEqual(watched);
    // It really contains what had already happened before the reload.
    const parts = (
      watched as Array<{ parts: Array<{ type: string }> }>
    ).flatMap((m) => m.parts.map((p) => p.type));

    expect(parts).toEqual(
      expect.arrayContaining(["text", "tool-call", "tool-result", "subagent"])
    );
  });

  it("restores 5 KB of already-streamed text and the run's own user message", async () => {
    const relay = new Relay();
    const long = "x".repeat(5_000);
    const l = await live({ reply: () => ({ stall: { say: long } }) });

    opened.push(l);
    l.onEvent((event) => relay.ingest(event));
    l.send(runInput("r2", "write a lot"));
    await l.waitFor(
      (events) =>
        events.some(
          (event) =>
            event.type === "TEXT_MESSAGE_CONTENT" &&
            (event as { delta: string }).delta === long
        ),
      "text streamed"
    );

    const restored = restoredClient(relay);

    await until(
      () =>
        restored.getMessages().some((message) => message.role === "assistant"),
      "restored text"
    );
    const text = restored
      .getMessages()
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => (part as { content: string }).content);

    expect(text).toEqual(["write a lot", long]);

    l.send({ type: "cancel", runId: "r2" });
    await l.waitFor(hasType("RUN_FINISHED"), "cancelled");
    await until(() => !restored.getIsLoading(), "restored client settled");
    expect(shape(restored.getMessages())).toEqual(shape(relay.messages()));
  });
});

describe("the relay's checkpoint", () => {
  const started = aguiEvent(EventType.RUN_STARTED, {
    threadId: "t-1",
    runId: "r",
  });
  const text = (delta: string) =>
    aguiEvent(EventType.TEXT_MESSAGE_CONTENT, { messageId: "m", delta });

  it("replays a call halfway through its arguments with no END, and the real END arrives live", async () => {
    const relay = new Relay();

    relay.ingest(started);
    relay.ingest(
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: "m",
        role: "assistant",
      })
    );
    relay.ingest(
      aguiEvent(EventType.TOOL_CALL_START, {
        toolCallId: "c",
        toolCallName: "bash",
        parentMessageId: "m",
      })
    );
    relay.ingest(
      aguiEvent(EventType.TOOL_CALL_ARGS, { toolCallId: "c", delta: '{"comm' })
    );

    const restored = restoredClient(relay);

    await until(() => restored.getMessages().length > 0, "replayed");
    relay.ingest(
      aguiEvent(EventType.TOOL_CALL_ARGS, {
        toolCallId: "c",
        delta: 'and":"ls"}',
      })
    );
    relay.ingest(
      aguiEvent(EventType.TOOL_CALL_END, {
        toolCallId: "c",
        metadata: { tanstack: { input: { command: "ls" } } },
      })
    );
    relay.ingest(aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: "m" }));
    relay.ingest(
      aguiEvent(EventType.RUN_FINISHED, {
        threadId: "t-1",
        runId: "r",
        outcome: { type: "success" },
        metadata: { tanstack: { finishReason: "stop" } },
      })
    );
    await until(() => !restored.getIsLoading(), "settled");

    const call = restored
      .getMessages()
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-call") as {
      input?: unknown;
      state: string;
    };

    expect(call.input).toEqual({ command: "ls" });
    expect(shape(restored.getMessages())).toEqual(shape(relay.messages()));
  });

  it("loses and duplicates nothing that lands between hydrate and the first joinRun event", async () => {
    const relay = new Relay();

    relay.ingest(started);
    relay.ingest(
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: "m",
        role: "assistant",
      })
    );
    relay.ingest(text("before "));

    const checkpoint = relay.hydrate();

    // Between the checkpoint and the replay: more text, a permission change, the terminal.
    relay.ingest(text("after"));
    relay.ingest(custom("permission.pending", { incarnation: "i", items: [] }));
    relay.ingest(aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: "m" }));
    relay.ingest(
      aguiEvent(EventType.RUN_FINISHED, {
        threadId: "t-1",
        runId: "r",
        outcome: { type: "success" },
      })
    );

    const seen: AguiEvent[] = [];

    for await (const event of relay.joinRun("r")) seen.push(event);

    expect(checkpoint.activeRun).toEqual({ runId: "r" });
    const deltas = seen
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => (event as { delta: string }).delta);

    expect(deltas).toEqual(["before ", "after"]);
    expect(seen.filter((event) => event.type === "RUN_FINISHED")).toHaveLength(
      1
    );
    expect(seen.filter((event) => event.type === "CUSTOM")).toHaveLength(1);
  });

  it("round-trips a completed transcript through a fresh processor", () => {
    const events: AguiEvent[] = [
      started,
      aguiEvent(EventType.TEXT_MESSAGE_START, { messageId: "u", role: "user" }),
      aguiEvent(EventType.TEXT_MESSAGE_CONTENT, {
        messageId: "u",
        delta: "hi",
      }),
      aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: "u" }),
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: "m",
        role: "assistant",
      }),
      text("hello"),
      aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: "m" }),
      aguiEvent(EventType.RUN_FINISHED, {
        threadId: "t-1",
        runId: "r",
        outcome: { type: "success" },
      }),
    ];
    const next: AguiEvent[] = [
      aguiEvent(EventType.RUN_STARTED, { threadId: "t-1", runId: "r2" }),
      aguiEvent(EventType.TEXT_MESSAGE_START, {
        messageId: "m2",
        role: "assistant",
      }),
      aguiEvent(EventType.TEXT_MESSAGE_CONTENT, {
        messageId: "m2",
        delta: "again",
      }),
      aguiEvent(EventType.TEXT_MESSAGE_END, { messageId: "m2" }),
      aguiEvent(EventType.RUN_FINISHED, {
        threadId: "t-1",
        runId: "r2",
        outcome: { type: "success" },
      }),
    ];
    const continuous = new StreamProcessor();

    for (const event of [...events, ...next])
      continuous.processChunk(event as never);

    const relay = new Relay();

    for (const event of events) relay.ingest(event);
    const fresh = new StreamProcessor();

    fresh.setMessages(relay.hydrate().messages);
    for (const event of next) fresh.processChunk(event as never);

    expect(shape(fresh.getMessages())).toEqual(shape(continuous.getMessages()));
  });

  it("drops descriptors from a dead incarnation at hydrate", () => {
    const relay = new Relay();
    const descriptor = (incarnation: string) => ({
      id: "perm-1",
      reason: "abacus:permission" as const,
      message: "x",
      metadata: {
        abacus: {
          lineage: {
            threadId: "t-1",
            incarnation,
            turnSeq: 1,
            permissionId: "perm-1",
          },
          kind: "generic" as const,
          request: {} as never,
          attachedBy: "none" as const,
          allowed: ["accept" as const],
        },
      },
    });

    relay.ingest(
      custom("permission.pending", {
        incarnation: "old",
        items: [descriptor("old")],
      })
    );
    relay.ingest(
      custom("wire.hello", {
        protocol: 1,
        wire: "agui",
        compat: "fd",
        incarnation: "new",
      })
    );

    expect(relay.hydrate().descriptors).toEqual([]);
  });
});
