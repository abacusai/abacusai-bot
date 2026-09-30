/**
 * R2-T5 (spec 02 §3.4): the dispatcher wakes for a push while the server
 * read is idle and for an abort; items keep push order; a closed stream
 * ends; post-apply hooks run only after the consumer processed the chunk,
 * also when a replay exceeds the client's processing budget.
 */
import type { StreamChunk } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { golden } from "../fixtures/goldens";
import { FakeRelay } from "../fixtures/relay";
import { createDispatcher, type DispatchItem } from "./dispatcher";
import { ThreadSession } from "./session";

const chunk = (n: number): StreamChunk =>
  ({ type: "CUSTOM", name: `n${n}`, value: {} }) as unknown as StreamChunk;

describe("R2-T5 dispatcher", () => {
  it("wakes on push, keeps order, runs post after the consumer resumes", async () => {
    const log: string[] = [];
    const dispatcher = createDispatcher({
      pre: (item) => log.push(`pre ${item.seq}`),
      post: (item) => log.push(`post ${item.seq}`),
    });
    const controller = new AbortController();
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const event of dispatcher.stream(controller.signal)) {
        const n = Number((event as { name: string }).name.slice(1));
        log.push(`process ${n}`);
        seen.push(n);
        if (seen.length === 3) break;
      }
    })();
    // The consumer waits on an idle queue; a push wakes it.
    await Promise.resolve();
    dispatcher.push({ seq: 1, event: chunk(1) });
    dispatcher.push({ seq: 2, event: chunk(2) });
    await vi.waitFor(() => expect(seen).toEqual([1, 2]));
    dispatcher.push({ seq: 3, event: chunk(3) });
    await consumer;
    expect(seen).toEqual([1, 2, 3]);
    expect(log).toEqual([
      "pre 1",
      "process 1",
      "post 1",
      "pre 2",
      "process 2",
      "post 2",
      "pre 3",
      "process 3",
    ]);
  });

  it("wakes for an abort and ends a closed stream", async () => {
    const dispatcher = createDispatcher({ pre: () => {}, post: () => {} });
    const controller = new AbortController();
    const ended = (async () => {
      const items: unknown[] = [];
      for await (const event of dispatcher.stream(controller.signal))
        items.push(event);
      return items;
    })();
    controller.abort();
    await expect(ended).resolves.toEqual([]);

    const closed = createDispatcher({ pre: () => {}, post: () => {} });
    closed.push({ seq: 1, event: chunk(1) });
    closed.close();
    const items: unknown[] = [];
    for await (const event of closed.stream()) items.push(event);
    expect(items).toHaveLength(1);
    closed.push({ seq: 2, event: chunk(2) });
    expect(closed.pending).toBe(0);
  });

  it("records a terminal only after the client processed it, across a large replay", async () => {
    // A long active run: many tool calls, then its terminal, replayed at once.
    const base = golden("tool-bash");
    const start = base.findIndex((item) => item.event.type === "RUN_STARTED");
    const run = base.slice(start);
    const events: DispatchItem[] = base.slice(0, start);
    let seq = events.length;
    const push = (event: StreamChunk) => events.push({ seq: ++seq, event });
    const userEnd = run.findIndex((item) => item.event.type === "TEXT_MESSAGE_END");
    for (const item of run.slice(0, userEnd + 1)) push(item.event);
    push({ type: "TEXT_MESSAGE_START", messageId: "a-1", role: "assistant" } as StreamChunk);
    for (let index = 0; index < 400; index += 1) {
      push({ type: "TOOL_CALL_START", toolCallId: `c-${index}`, toolCallName: "bash", parentMessageId: "a-1" } as StreamChunk);
      push({ type: "TOOL_CALL_ARGS", toolCallId: `c-${index}`, delta: JSON.stringify({ command: `echo ${index}` }) } as StreamChunk);
      push({ type: "TOOL_CALL_END", toolCallId: `c-${index}`, metadata: { tanstack: { input: { command: `echo ${index}` } } } } as unknown as StreamChunk);
      push({ type: "TOOL_CALL_RESULT", messageId: `c-${index}:result`, toolCallId: `c-${index}`, role: "tool", content: JSON.stringify({ text: `${index}\n`, rejected: false }) } as unknown as StreamChunk);
    }
    push({ type: "TEXT_MESSAGE_END", messageId: "a-1" } as StreamChunk);
    const relay = new FakeRelay({ events });
    const session = new ThreadSession({ ai: relay.ai, threadId: relay.threadId });
    try {
      await session.load();
      relay.emit({ type: "RUN_FINISHED", threadId: "t-1", runId: "srv-<1>", outcome: { type: "success" } } as unknown as StreamChunk);
      await vi.waitFor(() => expect(session.store.state.runs.outcomes).toHaveLength(1));
      const [outcome] = session.store.state.runs.outcomes;
      expect(outcome!.steps).toBe(400);
      expect(outcome!.afterMessageId).toBe("a-1");
      expect(session.store.state.runs.active).toBeNull();
    } finally {
      session.retire();
    }
  });
});
