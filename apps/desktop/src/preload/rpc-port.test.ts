/**
 * A-T4, preload half: the port handshake answers once per document, only its
 * own window's requests, and never hands out a second port.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handshakeDelayFromEnv,
  installRpcPortHandshake,
  RPC_CONNECT_CHANNEL,
  RPC_CONNECT_REQUEST,
  RPC_PORT_RESPONSE,
  type HandshakeMessageEvent,
  type HandshakeWindow,
} from "./rpc-port";

class FakeWindow implements HandshakeWindow {
  readonly posted: Array<{ message: unknown; transfer?: unknown[] }> = [];
  private readonly listeners: Array<(event: HandshakeMessageEvent) => void> =
    [];

  addEventListener(
    _type: "message",
    listener: (event: HandshakeMessageEvent) => void
  ): void {
    this.listeners.push(listener);
  }

  postMessage(message: unknown, _origin: string, transfer?: unknown[]): void {
    this.posted.push({ message, ...(transfer == null ? {} : { transfer }) });
  }

  /** A message as the page (or `source`) would post it. */
  receive(data: unknown, source: unknown = this): void {
    for (const listener of this.listeners) listener({ source, data });
  }
}

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

const setup = (delayMs = 0) => {
  const win = new FakeWindow();
  const postMessage = vi.fn(
    (_channel: string, _message: unknown, transfer?: MessagePort[]) => {
      ports.push(...(transfer ?? []));
    }
  );
  installRpcPortHandshake({ postMessage } as never, win, "main", { delayMs });
  return { win, postMessage };
};

const request = (nonce: string) => ({ type: RPC_CONNECT_REQUEST, nonce });

describe("the preload's port handshake (A-T4)", () => {
  it("gives the first request a channel: one end to main, one to the page", () => {
    const { win, postMessage } = setup();

    win.receive(request("n1"));

    expect(postMessage).toHaveBeenCalledTimes(1);
    const [channel, message, transfer] = postMessage.mock.calls[0]!;
    expect(channel).toBe(RPC_CONNECT_CHANNEL);
    expect(message).toEqual({ kind: "main" });
    expect(transfer).toHaveLength(1);

    expect(win.posted).toHaveLength(1);
    expect(win.posted[0]!.message).toEqual({
      type: RPC_PORT_RESPONSE,
      nonce: "n1",
    });
    expect(win.posted[0]!.transfer).toHaveLength(1);
    ports.push(...(win.posted[0]!.transfer as MessagePort[]));
  });

  it("answers a second or late request already-connected, with no port", () => {
    const { win, postMessage } = setup();

    win.receive(request("n1"));
    ports.push(...(win.posted[0]!.transfer as MessagePort[]));
    win.receive(request("n2"));
    win.receive(request("n3"));

    // Main heard exactly once.
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(win.posted.slice(1)).toEqual([
      {
        message: {
          type: RPC_PORT_RESPONSE,
          nonce: "n2",
          error: "already-connected",
        },
      },
      {
        message: {
          type: RPC_PORT_RESPONSE,
          nonce: "n3",
          error: "already-connected",
        },
      },
    ]);
  });

  it("ignores messages from other frames and anything that is not a request", () => {
    const { win, postMessage } = setup();

    win.receive(request("n1"), { some: "iframe" });
    win.receive({ type: "something-else", nonce: "n1" });
    win.receive({ type: RPC_CONNECT_REQUEST, nonce: 42 });
    win.receive(null);
    win.receive("abacus:rpc-connect");

    expect(postMessage).not.toHaveBeenCalled();
    expect(win.posted).toEqual([]);

    // The document's one answer is still available after the noise.
    win.receive(request("n1"));
    expect(postMessage).toHaveBeenCalledTimes(1);
    ports.push(...(win.posted[0]!.transfer as MessagePort[]));
  });

  describe("with a delayed answer (the test-only knob)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("sends main its end at once and the page's after the delay", () => {
      const { win, postMessage } = setup(6_000);

      win.receive(request("n1"));
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(win.posted).toEqual([]);

      vi.advanceTimersByTime(6_000);
      expect(win.posted).toHaveLength(1);
      ports.push(...(win.posted[0]!.transfer as MessagePort[]));
    });
  });

  it("is never delayed by the shipped preload", () => {
    // Only the real-Electron test's own preload entry passes a delay; the
    // production preload must not read the test variable at all.
    const source = readFileSync(join(import.meta.dirname, "index.ts"), "utf8");
    expect(source).not.toMatch(/handshakeDelayFromEnv|delayMs/);
    expect(
      source.replace(/\/\/.*$/gm, "").includes("ABACUS_TEST_HANDSHAKE_DELAY_MS")
    ).toBe(false);
  });

  it("reads the delay from the environment, and nothing else", () => {
    expect(handshakeDelayFromEnv({})).toBe(0);
    expect(
      handshakeDelayFromEnv({ ABACUS_TEST_HANDSHAKE_DELAY_MS: "6000" })
    ).toBe(6000);
    expect(handshakeDelayFromEnv({ ABACUS_TEST_HANDSHAKE_DELAY_MS: "x" })).toBe(
      0
    );
    expect(
      handshakeDelayFromEnv({ ABACUS_TEST_HANDSHAKE_DELAY_MS: "-5" })
    ).toBe(0);
  });
});
