/**
 * A-T4, renderer half: one request per document, a port that comes late or
 * for someone else is closed on arrival, and an HMR re-import reuses the
 * document's promise instead of asking again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeWindow } from "./fake-window";
import {
  RPC_CONNECT_REQUEST,
  RPC_PORT_RESPONSE,
  requestRpcPort,
  TransportUnavailableError,
} from "./message-port";

const open: MessagePort[] = [];

afterEach(() => {
  for (const port of open.splice(0)) port.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const channel = (): { mine: MessagePort; main: MessagePort } => {
  const { port1, port2 } = new MessageChannel();
  open.push(port1, port2);
  return { mine: port2, main: port1 };
};

/** Answers the page the way the preload does, immediately. */
const answerRequests = (win: FakeWindow): void => {
  let answered = false;
  win.addEventListener("message", (event) => {
    const data = event.data as { type?: string; nonce?: string };
    if (data?.type !== RPC_CONNECT_REQUEST) return;
    if (answered) {
      win.deliver({
        type: RPC_PORT_RESPONSE,
        nonce: data.nonce,
        error: "already-connected",
      });
      return;
    }
    answered = true;
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: data.nonce }, [
      channel().mine,
    ]);
  });
};

describe("requesting this document's port (A-T4)", () => {
  it("posts one request with a nonce and resolves with the matching port", async () => {
    const win = new FakeWindow();
    answerRequests(win);

    const port = await requestRpcPort({
      win: win.asWindow(),
      nonce: () => "n1",
    });

    expect(port).toBeInstanceOf(MessagePort);
    expect(win.posted).toEqual([{ type: RPC_CONNECT_REQUEST, nonce: "n1" }]);
  });

  it("closes a port that arrives after the timeout", async () => {
    vi.useFakeTimers();
    const win = new FakeWindow();

    const pending = requestRpcPort({
      win: win.asWindow(),
      timeoutMs: 5_000,
      nonce: () => "n1",
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      TransportUnavailableError
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    const late = channel().mine;
    const close = vi.spyOn(late, "close");
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: "n1" }, [late]);

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes a port answering a nonce it is not waiting on", async () => {
    const win = new FakeWindow();
    const pending = requestRpcPort({
      win: win.asWindow(),
      timeoutMs: 1_000,
      nonce: () => "mine",
    });

    const stray = channel().mine;
    const close = vi.spyOn(stray, "close");
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: "someone-else" }, [stray]);
    expect(close).toHaveBeenCalledTimes(1);

    // Still waiting for its own.
    const own = channel().mine;
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: "mine" }, [own]);
    await expect(pending).resolves.toBe(own);
  });

  it("ignores answers that did not come from its own window", async () => {
    const win = new FakeWindow();
    const pending = requestRpcPort({
      win: win.asWindow(),
      timeoutMs: 1_000,
      nonce: () => "n1",
    });

    const framed = channel().mine;
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: "n1" }, [framed], {
      frame: true,
    });
    const own = channel().mine;
    win.deliver({ type: RPC_PORT_RESPONSE, nonce: "n1" }, [own]);

    await expect(pending).resolves.toBe(own);
  });

  it("rejects when the preload says the document is already connected", async () => {
    const win = new FakeWindow();
    answerRequests(win);
    await requestRpcPort({ win: win.asWindow(), nonce: () => "first" });

    await expect(
      requestRpcPort({ win: win.asWindow(), nonce: () => "second" })
    ).rejects.toMatchObject({
      name: "TransportUnavailableError",
      reason: "already-connected",
    });
  });
});

describe("getTransport across an HMR re-import (A-T4)", () => {
  it("reuses the document's promise and posts no second request", async () => {
    const win = new FakeWindow();
    answerRequests(win);
    vi.stubGlobal("window", win);
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("abacus.transport")
    ];

    vi.resetModules();
    const first = await import("./index");
    const a = await first.getTransport();

    // Vite re-runs the module; the global promise survives it.
    vi.resetModules();
    const second = await import("./index");
    const b = await second.getTransport();

    expect(b).toBe(a);
    expect(
      win.posted.filter(
        (message) => (message as { type?: string }).type === RPC_CONNECT_REQUEST
      )
    ).toHaveLength(1);

    a.close();
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("abacus.transport")
    ];
  });
});
