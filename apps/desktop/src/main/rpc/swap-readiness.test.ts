/**
 * A-T10: a renderer swap under the `subscriptions` barrier (spec 00 A.4.6).
 * The candidate flips only once it reports ready; a failure or no report in
 * SWAP_READY_TIMEOUT_MS discards it and the old renderer stays live; the
 * discarded candidate's port closes, so its iterators end and the bus is
 * back to baseline; retries are capped per version.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let nextId = 100;

  class FakeWebContents {
    readonly id = nextId++;
    readonly mainFrame = { main: true };
    destroyed = false;
    url = "";
    private readonly listeners = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();
    readonly close = vi.fn(() => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("destroyed");
    });
    readonly executeJavaScript = vi.fn(async () => null);
    readonly focus = vi.fn();

    isDestroyed(): boolean {
      return this.destroyed;
    }
    isFocused(): boolean {
      return false;
    }
    getURL(): string {
      return this.url;
    }
    async loadURL(url: string): Promise<void> {
      this.url = url;
    }
    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [
        ...(this.listeners.get(event) ?? []),
        listener,
      ]);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        listener(...args);
      };
      return this.on(event, wrapped);
    }
    off(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((l) => l !== listener)
      );
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }

  class FakeWebContentsView {
    bounds = { height: 0, width: 0, x: 0, y: 0 };
    readonly webContents = new FakeWebContents();
    getBounds() {
      return this.bounds;
    }
    setBackgroundColor(): void {}
    setBounds(bounds: { height: number; width: number; x: number; y: number }) {
      this.bounds = bounds;
    }
  }

  class FakeWindow {
    readonly children: FakeWebContentsView[] = [];
    readonly contentView = {
      addChildView: (view: FakeWebContentsView, index?: number) => {
        this.children.splice(index ?? this.children.length, 0, view);
      },
      children: this.children,
      removeChildView: (view: FakeWebContentsView) => {
        const at = this.children.indexOf(view);
        if (at !== -1) this.children.splice(at, 1);
      },
    };
    getContentBounds() {
      return { height: 600, width: 800, x: 0, y: 0 };
    }
    isDestroyed(): boolean {
      return false;
    }
    on(): void {}
  }

  return { FakeWebContents, FakeWebContentsView, FakeWindow };
});

vi.mock("electron", () => ({ WebContentsView: mocks.FakeWebContentsView }));

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/message-port";
import type { ContractRouterClient } from "@orpc/contract";

import type { Contract } from "@abacus-ai/contract/contract";
import { CUSTOM_JSON_SERIALIZERS } from "@abacus-ai/contract/contract/serializer";

import {
  MAX_SWAP_READINESS_ATTEMPTS,
  RendererHost,
  RendererSwapScheduler,
  SWAP_READY_TIMEOUT_MS,
  SwapNotReady,
  SwapRetryBudget,
} from "../renderer-host";
import { MainEventBus } from "./event-bus";
import { RendererReadiness } from "./readiness";
import { createRouter } from "./router";
import { fakeDeps } from "./testing";
import {
  installMessagePortTransport,
  RPC_CONNECT_CHANNEL,
  type MessagePortTransport,
} from "./transports/message-port";
import { publishToWindowViews } from "./window-events";

type FakeContents = InstanceType<typeof mocks.FakeWebContents>;

let readiness: RendererReadiness;
let bus: MainEventBus;
let transport: MessagePortTransport;
let connectListener: ((event: unknown) => void) | null;
const created: FakeContents[] = [];
const clientPorts: MessagePort[] = [];

beforeEach(() => {
  readiness = new RendererReadiness();
  bus = new MainEventBus();
  connectListener = null;
  created.length = 0;
  transport = installMessagePortTransport({
    ipcMain: {
      on: (channel: string, listener: (event: unknown) => void) => {
        if (channel === RPC_CONNECT_CHANNEL) connectListener = listener;
      },
      removeListener: () => undefined,
    } as never,
    router: createRouter(),
    deps: fakeDeps({ bus }),
    readiness,
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const port of clientPorts.splice(0)) port.close();
});

const makeHost = () => {
  const window = new mocks.FakeWindow();
  const host = new RendererHost({
    backgroundColor: "#000",
    webPreferences: {},
    window: window as never,
    wire: (contents) => {
      created.push(contents as unknown as FakeContents);
      transport.registerRendererContents(contents, "main");
    },
    readiness,
  });
  return { host, window };
};

/** Resolves with the candidate's webContents once the swap has made it. */
const candidate = async (): Promise<FakeContents> => {
  await vi.waitFor(() => expect(created.length).toBe(2));
  return created[1]!;
};

/**
 * Connect `contents` the way its preload would, and open an iterator on the
 * port, so a discarded candidate has something to leak.
 */
const connectAndSubscribe = async (
  contents: FakeContents
): Promise<ContractRouterClient<Contract>> => {
  const { port1, port2 } = new MessageChannel();
  clientPorts.push(port2);
  // Node's port delivers bare messages; Electron's delivers { data }.
  const mainPort = {
    on: (event: string, listener: (...args: unknown[]) => void) => {
      port1.on(event as "message", (data: unknown) =>
        event === "message" ? listener({ data }) : listener()
      );
    },
    postMessage: (message: unknown) => port1.postMessage(message),
    start: () => port1.start(),
    close: () => port1.close(),
  };
  connectListener?.({
    ports: [mainPort],
    sender: contents,
    senderFrame: contents.mainFrame,
  });
  const client: ContractRouterClient<Contract> = createORPCClient(
    new RPCLink({ port: port2, customJsonSerializers: CUSTOM_JSON_SERIALIZERS })
  );
  port2.start();
  const events = await client.bots.events();
  void events.next().catch(() => undefined);
  return client;
};

describe("swap readiness (A-T10)", () => {
  it("flips once the candidate reports its subscriptions live", async () => {
    const { host } = makeHost();
    const first = host.webContents;

    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const next = await candidate();
    readiness.report(next.id, { barrier: "subscriptions" });

    await expect(swapping).resolves.toBe(true);
    expect(host.webContents).not.toBe(first);
    expect(host.webContents).toBe(next);
  });

  it("aborts when the candidate reports failed, and the old view stays", async () => {
    const { host, window } = makeHost();
    const first = host.webContents;
    const liveView = window.children[0];

    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const next = await candidate();
    readiness.report(next.id, { barrier: "failed", reason: "prefs snapshot" });

    await expect(swapping).rejects.toBeInstanceOf(SwapNotReady);
    expect(host.webContents).toBe(first);
    expect(window.children).toEqual([liveView]);
    expect(next.close).toHaveBeenCalled();
  });

  it("aborts when nothing is reported within SWAP_READY_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    const first = host.webContents;

    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const rejected = expect(swapping).rejects.toMatchObject({
      name: "SwapNotReady",
      outcome: "timeout",
    });
    await vi.advanceTimersByTimeAsync(SWAP_READY_TIMEOUT_MS - 1);
    expect(host.webContents).toBe(first);
    await vi.advanceTimersByTimeAsync(1);

    await rejected;
    expect(host.webContents).toBe(first);
  });

  it("closes an aborted candidate's port, ending its iterators", async () => {
    const { host } = makeHost();
    const baseline = bus.listenerCount();

    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const next = await candidate();
    await connectAndSubscribe(next);
    expect(transport.livePorts()).toBe(1);
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));

    readiness.report(next.id, { barrier: "failed", reason: "no" });
    await expect(swapping).rejects.toBeInstanceOf(SwapNotReady);

    expect(transport.livePorts()).toBe(0);
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
  });

  it("gives a candidate the window changes made between its subscription and the flip", async () => {
    const { host } = makeHost();
    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const next = await candidate();
    const client = await connectAndSubscribe(next);
    const events = await client.window.events();

    // Full screen entered while the candidate is still hidden: main publishes
    // to every view in the window, as index.ts does.
    const state = {
      isFullScreen: true,
      isMaximized: false,
      isFocused: true,
    };
    publishToWindowViews(
      (channel, payload) => bus.dispatchChannel(channel, payload),
      transport.registeredIds(),
      host.webContents.id,
      { type: "state", state: state as never }
    );
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "state", state: { isFullScreen: true } },
    });

    readiness.report(next.id, { barrier: "subscriptions" });
    await expect(swapping).resolves.toBe(true);
    await events.return();
  });

  it("fails at once, not at the timeout, when the candidate is destroyed", async () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    const first = host.webContents;
    const swapping = host.swap(new URL("app://bundle.new/"), {
      barrier: "subscriptions",
    });
    const rejected = expect(swapping).rejects.toMatchObject({
      name: "SwapNotReady",
      outcome: "failed",
    });
    const next = await candidate();
    next.close();

    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(host.webContents).toBe(first);
  });

  describe("the swap scheduler's retries (impl-r1)", () => {
    const setupScheduler = () => {
      let target = new URL("app://bundle.v2/");
      const swap = vi.fn(
        async (_url: URL, _options?: unknown): Promise<boolean> => {
          throw new SwapNotReady("timeout");
        }
      );
      const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const scheduler = new RendererSwapScheduler({
        target: () => target,
        host: () => ({ swap }),
        busy: () => false,
        barrier: "subscriptions",
        pollMs: 1_000,
        log,
      });
      return {
        scheduler,
        swap,
        log,
        retarget: (url: string) => {
          target = new URL(url);
        },
      };
    };

    it("retries at the next idle tick, never in the same one", async () => {
      vi.useFakeTimers();
      const { scheduler, swap } = setupScheduler();

      scheduler.schedule("2.0.0");
      await vi.advanceTimersByTimeAsync(0);
      expect(swap).toHaveBeenCalledTimes(1);
      expect(scheduler.pending).toBe(true);

      await vi.advanceTimersByTimeAsync(999);
      expect(swap).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(swap).toHaveBeenCalledTimes(2);
      scheduler.cancel();
    });

    it("stops after three failures of the URL it swapped to, checking before the swap", async () => {
      vi.useFakeTimers();
      const { scheduler, swap, log } = setupScheduler();

      scheduler.schedule("2.0.0");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(swap).toHaveBeenCalledTimes(MAX_SWAP_READINESS_ATTEMPTS);
      expect(scheduler.pending).toBe(false);

      // Scheduled again for the same bundle: refused before any swap.
      scheduler.schedule("2.0.0");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(swap).toHaveBeenCalledTimes(MAX_SWAP_READINESS_ATTEMPTS);
      expect(log.warn).toHaveBeenCalled();
    });

    it("keys the budget on the bundle URL, not the version label", async () => {
      vi.useFakeTimers();
      const { scheduler, swap, retarget } = setupScheduler();

      scheduler.schedule("2.0.0");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(swap).toHaveBeenCalledTimes(3);

      // The same label, now served from another bundle: its own budget.
      retarget("app://bundle.v2b/");
      scheduler.schedule("2.0.0");
      await vi.advanceTimersByTimeAsync(0);
      expect(swap).toHaveBeenCalledTimes(4);
      expect(String(swap.mock.calls.at(-1)?.[0])).toBe("app://bundle.v2b/");
      scheduler.cancel();
    });
  });

  it("retries a version that never became ready at most three times", () => {
    const budget = new SwapRetryBudget();
    expect(MAX_SWAP_READINESS_ATTEMPTS).toBe(3);

    expect(budget.fail("2.0.0")).toBe(true);
    expect(budget.fail("2.0.0")).toBe(true);
    expect(budget.fail("2.0.0")).toBe(false);
    // Another version has its own budget.
    expect(budget.fail("2.0.1")).toBe(true);
  });
});
