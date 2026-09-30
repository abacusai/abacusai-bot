/**
 * R2-T2 (spec 02 §3.5): the host `satisfies UseChatReturn` from
 * `@tanstack/ai-react@0.29.3` (compiled by tsc -b in host.ts, and checked
 * here with expectTypeOf); `sendMessage`/`reload`/`stop` map to
 * `submit`/`retry`/`cancel` and return `Promise<void>`; after a generation
 * swap, the old client's teardown, a late ack and a late older page leave
 * the new binding untouched.
 */
import type { UseChatReturn } from "@tanstack/ai-react";
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { buildThreadHost, useThreadHost } from "./host";
import { ThreadSession } from "./session";

const sessions: ThreadSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.retire();
});

const open = async (relay: FakeRelay) => {
  const session = new ThreadSession({ ai: relay.ai, threadId: "t-1" });
  sessions.push(session);
  await session.load();
  return session;
};

describe("R2-T2 host", () => {
  it("is a UseChatReturn whose request methods return Promise<void>", () => {
    expectTypeOf(buildThreadHost).returns.toEqualTypeOf<UseChatReturn>();
    expectTypeOf<UseChatReturn["sendMessage"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<UseChatReturn["reload"]>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<ThreadSession["submit"]>().returns.resolves.toHaveProperty("kind");
  });

  it("maps sendMessage, reload and stop to the session", async () => {
    const relay = new FakeRelay();
    relay.emitAll(b.sessionReady());
    const session = await open(relay);
    const submit = vi.spyOn(session, "submit").mockResolvedValue({ kind: "started" });
    const retry = vi.spyOn(session, "retry").mockResolvedValue({ kind: "started" });
    const cancel = vi.spyOn(session, "cancel").mockResolvedValue();
    const { result } = renderHook(() => useThreadHost(session));
    await expect(result.current.sendMessage("hi")).resolves.toBeUndefined();
    expect(submit).toHaveBeenCalledWith("hi");
    await expect(result.current.reload()).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalled();
    result.current.stop();
    expect(cancel).toHaveBeenCalled();
    expect(() => result.current.setMessages([])).toThrow(/not supported/);
  });

  it("a swap isolates the new binding from the old generation's teardown, late acks and late pages", async () => {
    let releaseAck!: () => void;
    const relay = new FakeRelay({
      onSend: (input) =>
        new Promise((resolve) => {
          releaseAck = () => resolve({ runId: input.runId, status: "started" });
        }),
    });
    relay.emitAll([...b.sessionReady(), ...Array.from({ length: 60 }, (_, i) => [b.runStarted(`r${i}`), ...b.text(`u${i}`, "user", `m${i}`), b.runFinished(`r${i}`)]).flat()]);
    const session = await open(relay);
    expect(session.hostStore.state.hasOlderMessages).toBe(true);
    // A page and an ack in flight across a new generation.
    let releasePage!: () => void;
    relay.faults.hydrate = (call) =>
      call === 2
        ? new Promise<void>((resolve) => {
            releasePage = resolve;
          })
        : null;
    const page = session.loadOlder();
    const ack = session.submit("late");
    await vi.waitFor(() => expect(relay.stats.send).toHaveLength(1));
    const before = session.hostStore.state.client;
    await session.reconnect();
    const after = session.hostStore.state;
    expect(after.client).not.toBe(before);
    const messages = after.messages;
    releasePage();
    await page;
    releaseAck();
    await expect(ack).resolves.toEqual({ kind: "stale" });
    expect(session.hostStore.state.messages).toBe(messages);
    expect(session.hostStore.state.client).toBe(after.client);
    expect(session.hostStore.state.connection).not.toBe("error");
  });
});
