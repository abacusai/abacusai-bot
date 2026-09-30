/**
 * R2-T20 (spec 02 §8.3, §3.7): the `routeSubmit` truth table, the ported
 * `deriveSessionTitle` cases, and admission isolation: while run A streams
 * partial tool arguments and reasoning, admission B is acked `queued`, then
 * `rejected`, then throws `UNAVAILABLE`; A's parts continue and end equal
 * to an undisturbed run; B's outbox entry appears and leaves without a
 * processor change; `started` removes the entry when the echo is processed.
 */
import { ORPCError } from "@orpc/client";
import type { StreamChunk } from "@tanstack/ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { deriveSessionTitle, routeSubmit, type SubmitInput } from "./send";
import { ThreadSession } from "./session";

const base: SubmitInput = {
  text: "hello",
  attachments: [],
  busy: false,
  readOnly: false,
  questionPending: false,
  preStart: false,
  hydrated: true,
};

describe("R2-T20 routeSubmit", () => {
  it("routes by state", () => {
    expect(routeSubmit({ ...base, text: "  " })).toEqual({ kind: "noop" });
    expect(routeSubmit({ ...base, readOnly: true })).toEqual({
      kind: "blocked",
      reason: "read-only",
    });
    expect(routeSubmit({ ...base, questionPending: true })).toEqual({
      kind: "blocked",
      reason: "question-pending",
    });
    expect(
      routeSubmit({
        ...base,
        attachments: [{ path: null, state: "uploading" }],
      })
    ).toEqual({ kind: "blocked", reason: "uploading" });
    expect(routeSubmit({ ...base, hydrated: false })).toEqual({
      kind: "blocked",
      reason: "loading",
    });
    expect(routeSubmit(base)).toEqual({ kind: "send", text: "hello" });
    expect(routeSubmit({ ...base, busy: true })).toEqual({
      kind: "enqueue",
      text: "hello",
    });
    expect(routeSubmit({ ...base, composing: true })).toEqual({ kind: "noop" });
  });

  it("sends mode and model only before the runtime exists (or a fixed mode)", () => {
    expect(
      routeSubmit({
        ...base,
        preStart: true,
        mode: "PLAN" as never,
        model: "m-1",
      })
    ).toEqual({
      kind: "send",
      text: "hello",
      forwardedProps: { mode: "PLAN", model: "m-1" },
    });
    expect(
      routeSubmit({ ...base, mode: "PLAN" as never, model: "m-1" })
    ).toEqual({
      kind: "send",
      text: "hello",
    });
    expect(routeSubmit({ ...base, fixedMode: "YOLO" as never })).toEqual({
      kind: "send",
      text: "hello",
      forwardedProps: { mode: "YOLO" },
    });
  });

  it("appends attachments as @path lines; attachment-only is a prompt", () => {
    expect(
      routeSubmit({
        ...base,
        attachments: [{ path: "/a/b.pdf", state: "done" }],
      })
    ).toEqual({ kind: "send", text: "hello\n\n@/a/b.pdf" });
    expect(
      routeSubmit({
        ...base,
        text: "",
        attachments: [{ path: "/a/b.pdf", state: "done" }],
      })
    ).toEqual({ kind: "send", text: "@/a/b.pdf" });
  });

  it("derives session titles as the old transport did", () => {
    expect(deriveSessionTitle("/help me with this")).toBe("help me with this");
    expect(deriveSessionTitle("look at @src/main/index.ts please")).toBe(
      "look at index.ts please"
    );
    expect(deriveSessionTitle("```js\nconst a = 1\n```")).toBe("");
    expect(deriveSessionTitle("a".repeat(80))).toBe(`${"a".repeat(48)}…`);
    expect(
      deriveSessionTitle(
        "the quick brown fox jumps over the lazy dog and keeps running"
      )
    ).toBe("the quick brown fox jumps over the lazy dog and…");
  });
});

const sessions: ThreadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

const runA = (): { head: StreamChunk[]; tail: StreamChunk[] } => {
  const head = [
    ...b.sessionReady(),
    b.runStarted("run-a"),
    ...b.text("u-a", "user", "first"),
    b.textStart("a-1"),
    ...b.reasoning("r-1", "Let me think"),
    b.toolStart("call-1", "bash", "a-1"),
    b.toolArgs("call-1", '{"comm'),
  ];
  const tail = [
    b.toolArgs("call-1", 'and":"ls"}'),
    b.toolEnd("call-1", { command: "ls" }),
    b.toolResult("call-1", { text: "a\nb\n" }),
    b.textDelta("a-1", "Done."),
    b.textEnd("a-1"),
    b.runFinished("run-a"),
  ];
  return { head, tail };
};

const timeless = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      key === "createdAt" ? undefined : v
    )
  );

describe("R2-T20 admission isolation", () => {
  it("queued, rejected and UNAVAILABLE never touch a streaming run", async () => {
    const { head, tail } = runA();
    const reference = new FakeRelay();
    reference.emitAll([...head, ...tail]);
    const refSession = new ThreadSession({ ai: reference.ai, threadId: "t-1" });
    sessions.push(refSession);
    await refSession.load();
    const expected = timeless(refSession.hostStore.state.messages);

    const acks: Array<"queued" | "rejected" | "throw"> = [
      "queued",
      "rejected",
      "throw",
    ];
    const relay = new FakeRelay({
      onSend: (input) => {
        const next = acks.shift();
        if (next === "throw") throw new ORPCError("UNAVAILABLE", { data: {} });
        return { runId: input.runId, status: next! };
      },
    });
    relay.emitAll(head);
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    const client = session.hostStore.state.client!;
    const outboxSeen: number[] = [];
    session.hostStore.subscribe(() =>
      outboxSeen.push(session.hostStore.state.outbox.length)
    );

    await expect(session.submit("second")).resolves.toEqual({ kind: "queued" });
    await expect(session.submit("third")).resolves.toEqual({
      kind: "rejected",
    });
    await expect(session.submit("fourth")).rejects.toBeInstanceOf(ORPCError);
    expect(outboxSeen).toContain(1);
    expect(session.hostStore.state.outbox).toEqual([]);
    expect(session.hostStore.state.client).toBe(client);

    relay.emitAll(tail);
    await vi.waitFor(() =>
      expect(session.store.state.runs.outcomes).toHaveLength(1)
    );
    expect(timeless(session.hostStore.state.messages)).toEqual(expected);
  });

  it("started: the entry stays until its echo is processed, then leaves", async () => {
    const relay = new FakeRelay({
      onSend: (input, r) => {
        const id = input.messages[0]!.id;
        const text = (
          input.messages[0]!.parts[0] as unknown as { content: string }
        ).content;
        setTimeout(() => {
          r.emitAll([b.runStarted(input.runId), ...b.text(id, "user", text)]);
        }, 10);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    await expect(session.submit("hi")).resolves.toEqual({ kind: "started" });
    const [entry] = session.hostStore.state.outbox;
    expect(entry?.state).toBe("accepted");
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
    const users = session.hostStore.state.messages.filter(
      (m) => m.role === "user"
    );
    expect(users.map((m) => m.id)).toEqual([entry!.id]);
  });

  it("abacus.duplicate_echo clears a retry's entry (§14.12)", async () => {
    const relay = new FakeRelay({
      onSend: (input, r) => {
        setTimeout(() => {
          r.emitAll([
            b.runStarted(input.runId),
            b.custom("abacus.duplicate_echo", {
              runId: input.runId,
              messageId: input.messages[0]!.id,
            }),
          ]);
        }, 5);
        return { runId: input.runId, status: "started" };
      },
    });
    relay.emitAll(b.sessionReady());
    const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
    sessions.push(session);
    await session.load();
    await session.submit("again");
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
  });
});
