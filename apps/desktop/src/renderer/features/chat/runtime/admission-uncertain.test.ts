/**
 * R2-T35 (spec 02 §3.7, review r3-5): uncertain admissions. The relay fake
 * answers a repeated run id with the recorded original ack (§14.5).
 */
import { ORPCError } from "@orpc/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  memoryRelay,
  closeMemoryRelays,
} from "#renderer/test-support/chat-relay";
import type { AiSendInput } from "#shared/contract/ai";

import * as b from "../fixtures/builders";
import type { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
afterEach(() => {
  closeMemoryRelays();
  for (const session of sessions.splice(0)) session.retire();
});

const echo = (relay: FakeRelay, input: AiSendInput) => {
  const message = input.messages[0]!;
  relay.emitAll([
    b.runStarted(input.runId),
    ...b.text(
      message.id,
      "user",
      (message.parts[0] as unknown as { content: string }).content
    ),
  ]);
};

const open = async (relay: FakeRelay) => {
  relay.emitAll(b.sessionReady());
  const session = new ThreadSession({
    ai: relay.ai,
    threadId: "t-1",
    reconcileDelaysMs: [20, 40],
  });
  sessions.push(session);
  await session.load();
  return session;
};

const timeout = () => new ORPCError("TIMEOUT", { data: { ms: 30_000 } });

describe("R2-T35 uncertain admission", () => {
  it("(a) the echo before the RPC rejection confirms it; the rejection is ignored", async () => {
    const relay = await memoryRelay({
      onSend: async (input, r) => {
        echo(r, input);
        await vi.waitFor(() =>
          expect(session.hostStore.state.outbox).toEqual([])
        );
        return { runId: input.runId, status: "started" };
      },
    });
    relay.faults.send = (call) => (call === 1 ? timeout() : null);
    const session = await open(relay);
    // The echo is on the stream; let the client process it before the RPC settles.
    const result = session.submit("hello");
    await expect(result).resolves.toMatchObject({
      kind: "started",
    });
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(relay.stats.send).toHaveLength(1);
    expect(
      session.hostStore.state.messages.filter((m) => m.role === "user")
    ).toHaveLength(1);
  });

  it("(b) an echo after the failure: pending until it arrives", async () => {
    let pending: AiSendInput | null = null;
    const relay = await memoryRelay({
      onSend: (input) => {
        pending = input;
        return { runId: input.runId, status: "started" };
      },
    });
    relay.faults.send = () => timeout();
    const session = await open(relay);
    await expect(session.submit("hello")).resolves.toEqual({
      kind: "unconfirmed",
    });
    expect(session.hostStore.state.outbox[0]?.state).toBe("unconfirmed");
    echo(relay, pending!);
    await vi.waitFor(() => expect(session.hostStore.state.outbox).toEqual([]));
  });

  it("(c) a lost ack: the re-send is a duplicate of started, no second run", async () => {
    let runs = 0;
    const relay = await memoryRelay({
      onSend: (input) => {
        runs += 1;
        return { runId: input.runId, status: "started" };
      },
    });
    relay.faults.send = (call) => (call === 1 ? timeout() : null);
    const session = await open(relay);
    await expect(session.submit("hello")).resolves.toEqual({
      kind: "unconfirmed",
    });
    await vi.waitFor(() => expect(relay.stats.send).toHaveLength(2));
    expect(runs).toBe(1);
    expect(relay.stats.send[0]!.runId).toBe(relay.stats.send[1]!.runId);
    expect(relay.stats.send[0]!.messages[0]!.id).toBe(
      relay.stats.send[1]!.messages[0]!.id
    );
    await vi.waitFor(() =>
      expect(session.hostStore.state.outbox[0]?.state).toBe("accepted")
    );
  });

  it("(d) a prompt that never reached the agent is admitted once by the re-send", async () => {
    let runs = 0;
    const relay = await memoryRelay({
      onSend: (input) => {
        runs += 1;
        return { runId: input.runId, status: "started" };
      },
    });
    // The first attempt dies before the server records an ack.
    relay.faults.sendLost = (call) => (call === 1 ? timeout() : null);
    const session = await open(relay);
    await expect(session.submit("hello")).resolves.toEqual({
      kind: "unconfirmed",
    });
    await vi.waitFor(() => expect(runs).toBe(1));
    await vi.waitFor(() =>
      expect(session.hostStore.state.outbox[0]?.state).toBe("accepted")
    );
  });

  it("(e) two failed re-sends: Not sent, and Discard gives the text back", async () => {
    const relay = await memoryRelay();
    relay.faults.send = () => timeout();
    const session = await open(relay);
    await session.submit("hello");
    await vi.waitFor(() =>
      expect(session.hostStore.state.outbox[0]?.state).toBe("failed")
    );
    expect(relay.stats.send).toHaveLength(3);
    const entry = session.discardOutbox(session.hostStore.state.outbox[0]!.id);
    expect(entry?.text).toBe("hello");
    expect(session.hostStore.state.outbox).toEqual([]);
  });

  it("(e) manual Retry keeps the reservation and cannot admit an already accepted run twice", async () => {
    let runs = 0;
    const relay = await memoryRelay({
      onSend: (input) => {
        runs += 1;
        return { runId: input.runId, status: "started" };
      },
    });
    relay.faults.send = (call) => (call <= 3 ? timeout() : null);
    const session = await open(relay);
    await session.submit("hello");
    await vi.waitFor(() =>
      expect(session.hostStore.state.outbox[0]?.state).toBe("failed")
    );
    const entry = session.hostStore.state.outbox[0]!;
    await expect(session.retryOutbox(entry.id)).resolves.toEqual({
      kind: "started",
    });
    expect(relay.stats.send).toHaveLength(4);
    expect(new Set(relay.stats.send.map((input) => input.runId))).toEqual(
      new Set([entry.runId])
    );
    expect(
      new Set(relay.stats.send.map((input) => input.messages[0]!.id))
    ).toEqual(new Set([entry.id]));
    expect(runs).toBe(1);
    expect(session.hostStore.state.outbox[0]?.state).toBe("accepted");
  });

  it("(f) UNAVAILABLE is definitive: the entry leaves at once", async () => {
    const relay = await memoryRelay();
    relay.faults.send = () => new ORPCError("UNAVAILABLE", { data: {} });
    const session = await open(relay);
    await expect(session.submit("hello")).rejects.toBeInstanceOf(ORPCError);
    expect(session.hostStore.state.outbox).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(relay.stats.send).toHaveLength(1);
  });
});
