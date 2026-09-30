/**
 * A-T3: who may connect, and what a connection leaves behind. Only a
 * registered webContents' main frame gets a port; a second connect replaces
 * the first; reloads and reconnects add no listeners; a destroyed webContents
 * is forgotten.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createRouter } from "../router";
import { fakeDeps } from "../testing";
import {
  installMessagePortTransport,
  RPC_CONNECT_CHANNEL,
  type MessagePortTransport,
} from "./message-port";

class FakePort extends EventEmitter {
  readonly start = vi.fn();
  readonly postMessage = vi.fn();
  readonly close = vi.fn(() => {
    // Electron reports `close` for the remote end; the transport must not
    // rely on it for its own.
  });
}

class FakeContents extends EventEmitter {
  static nextId = 1;
  readonly id = FakeContents.nextId++;
  readonly mainFrame = { name: "main frame" };
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  navigate(isMainFrame = true, isSameDocument = false): void {
    this.emit(
      "did-start-navigation",
      {},
      "app://x/",
      isSameDocument,
      isMainFrame
    );
  }

  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

type ConnectListener = (event: unknown) => void;

let connectListener: ConnectListener | null = null;
let transport: MessagePortTransport;

const ipcMain = {
  on: (channel: string, listener: ConnectListener) => {
    if (channel === RPC_CONNECT_CHANNEL) connectListener = listener;
  },
  removeListener: vi.fn(),
};

const connect = (
  contents: FakeContents,
  frame: unknown = contents.mainFrame
): FakePort => {
  const port = new FakePort();
  connectListener?.({ ports: [port], sender: contents, senderFrame: frame });
  return port;
};

const forget = vi.fn();

beforeEach(() => {
  connectListener = null;
  forget.mockClear();
  transport = installMessagePortTransport({
    ipcMain: ipcMain as never,
    router: createRouter(),
    deps: fakeDeps(),
    readiness: { forget },
  });
});

describe("connecting a renderer (A-T3)", () => {
  it("accepts a registered webContents' main frame", () => {
    const contents = new FakeContents();
    transport.registerRendererContents(contents as never, "main");

    const port = connect(contents);

    expect(port.close).not.toHaveBeenCalled();
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(transport.livePorts()).toBe(1);
  });

  it("refuses a subframe, an unregistered and a destroyed webContents", () => {
    const registered = new FakeContents();
    transport.registerRendererContents(registered as never, "main");

    const fromSubframe = connect(registered, { name: "iframe" });
    expect(fromSubframe.close).toHaveBeenCalledTimes(1);

    const stranger = connect(new FakeContents());
    expect(stranger.close).toHaveBeenCalledTimes(1);

    registered.destroy();
    const afterDestroy = connect(registered);
    expect(afterDestroy.close).toHaveBeenCalledTimes(1);
    expect(transport.isRegistered(registered.id)).toBe(false);
    expect(transport.livePorts()).toBe(0);
  });

  it("closes the previous port when the same document connects again", () => {
    const contents = new FakeContents();
    transport.registerRendererContents(contents as never, "main");

    const first = connect(contents);
    const second = connect(contents);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    expect(transport.livePorts()).toBe(1);
  });

  it("closes the port on a main-frame reload, and not on an in-page navigation", () => {
    const contents = new FakeContents();
    transport.registerRendererContents(contents as never, "main");
    const port = connect(contents);

    contents.navigate(true, true);
    contents.navigate(false, false);
    expect(port.close).not.toHaveBeenCalled();

    contents.navigate(true, false);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(transport.livePorts()).toBe(0);
    expect(forget).toHaveBeenCalledWith(contents.id);
  });

  it("clears a port the renderer closed", () => {
    const contents = new FakeContents();
    transport.registerRendererContents(contents as never, "main");
    const port = connect(contents);

    port.emit("close");

    expect(transport.livePorts()).toBe(0);
  });

  it("adds no listeners across 20 reloads and 20 connects", () => {
    const contents = new FakeContents();
    transport.registerRendererContents(contents as never, "main");
    // Registering twice is a no-op.
    transport.registerRendererContents(contents as never, "main");

    for (let round = 0; round < 20; round += 1) {
      connect(contents);
      contents.navigate();
      connect(contents);
      expect(transport.livePorts()).toBeLessThanOrEqual(1);
    }

    expect(contents.listenerCount("did-start-navigation")).toBe(1);
    expect(contents.listenerCount("destroyed")).toBe(1);

    contents.destroy();
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(transport.isRegistered(contents.id)).toBe(false);
    expect(transport.livePorts()).toBe(0);
  });

  it("keeps one port per webContents across several windows", () => {
    const a = new FakeContents();
    const b = new FakeContents();
    transport.registerRendererContents(a as never, "main");
    transport.registerRendererContents(b as never, "notch");

    connect(a);
    connect(b);
    connect(b);

    expect(transport.livePorts()).toBe(2);
  });
});
