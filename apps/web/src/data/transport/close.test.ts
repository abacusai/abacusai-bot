/**
 * Transport lifecycle (spec 01 §15.5): `state` and `onClose` on all three
 * constructors. `state` flips before listeners run; each registration fires
 * exactly once; a late listener fires once on the next microtask; `close()` is
 * idempotent and reports "explicit"; the other end going away reports
 * "port-closed".
 */
import { implement, type Router } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { contract } from "@abacus-ai/contract/contract";

import { createCloseSignal } from "./close-signal";
import { createTransport } from "./create-transport";
import { createMemoryTransport } from "./memory";
import type { Transport } from "./types";
import { createWebSocketTransport } from "./websocket";

const impl = implement(contract).$context<Record<string, never>>();
const router = {
  system: {
    info: impl.system.info.handler(() => new Promise<never>(() => {})),
  },
} as unknown as Router<any, Record<string, never>>;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const microtask = () => Promise.resolve();

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("createCloseSignal", () => {
  it("flips state before listeners run and fires each registration once", () => {
    const signal = createCloseSignal();
    const seen: string[] = [];
    const listener = (reason: string) => seen.push(`${signal.state}:${reason}`);
    signal.onClose(listener);
    signal.onClose(listener);
    signal.fire("port-closed");
    signal.fire("explicit");
    expect(seen).toEqual(["closed:port-closed", "closed:port-closed"]);
  });

  it("runs a late listener once, on the next microtask, with the first reason", async () => {
    const signal = createCloseSignal();
    signal.fire("explicit");
    const late = vi.fn();
    signal.onClose(late);
    expect(late).not.toHaveBeenCalled();
    await microtask();
    expect(late).toHaveBeenCalledExactlyOnceWith("explicit");
  });

  it("unsubscribes, before and after closure", async () => {
    const signal = createCloseSignal();
    const early = vi.fn();
    signal.onClose(early)();
    signal.fire("explicit");
    const late = vi.fn();
    signal.onClose(late)();
    await microtask();
    expect(early).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it("keeps notifying after a listener throws", () => {
    const signal = createCloseSignal();
    const after = vi.fn();
    const onError = vi.fn();
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (fn) => {
      try {
        fn();
      } catch (error) {
        onError(error);
      }
    };
    try {
      signal.onClose(() => {
        throw new Error("boom");
      });
      signal.onClose(after);
      signal.fire("explicit");
    } finally {
      globalThis.queueMicrotask = original;
    }
    expect(after).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });
});

/** Shared cases, per constructor. */
const lifecycleCases = (
  name: string,
  open: () => { transport: Transport; closeRemote(): void }
) => {
  describe(name, () => {
    it("starts open", () => {
      const { transport } = open();
      cleanups.push(() => transport.close());
      expect(transport.state).toBe("open");
    });

    it("reports an explicit close exactly once, idempotently", async () => {
      const { transport } = open();
      const listener = vi.fn(() => expect(transport.state).toBe("closed"));
      transport.onClose(listener);
      transport.close();
      transport.close();
      await tick();
      expect(listener).toHaveBeenCalledExactlyOnceWith("explicit");
      expect(transport.state).toBe("closed");
    });

    it("reports the other end going away as port-closed, once", async () => {
      const { transport, closeRemote } = open();
      const listener = vi.fn();
      transport.onClose(listener);
      closeRemote();
      await tick();
      transport.close();
      await tick();
      expect(listener).toHaveBeenCalledExactlyOnceWith("port-closed");
      expect(transport.state).toBe("closed");
    });

    it("calls a listener added after closure once, with the original reason", async () => {
      const { transport, closeRemote } = open();
      closeRemote();
      await tick();
      const late = vi.fn();
      transport.onClose(late);
      expect(late).not.toHaveBeenCalled();
      await microtask();
      expect(late).toHaveBeenCalledExactlyOnceWith("port-closed");
    });
  });
};

lifecycleCases("createTransport over a MessagePort", () => {
  const { port1: server, port2: client } = new MessageChannel();
  server.start();
  const transport = createTransport(client, { kind: "memory" });
  return { transport, closeRemote: () => server.close() };
});

lifecycleCases("createMemoryTransport", () => {
  const transport = createMemoryTransport(router, {});
  return { transport, closeRemote: () => transport.serverPort.close() };
});

/** A socket double: the link only listens and sends. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null;
  readyState = 1;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }

  /** The server hanging up. */
  drop(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

lifecycleCases("createWebSocketTransport", () => {
  const transport = createWebSocketTransport("ws://127.0.0.1:1/rpc", {
    WebSocket: FakeSocket as unknown as new (url: string) => WebSocket,
  });
  const socket = FakeSocket.last!;
  return { transport, closeRemote: () => socket.drop() };
});
