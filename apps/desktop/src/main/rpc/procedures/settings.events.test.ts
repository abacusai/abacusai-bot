import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcEvent } from "@abacus-ai/contract/contracts";

import {
  readExecBackend,
  readTerminalShell,
} from "../../services/config/settings";
import { MainEventBus } from "../event-bus";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "../testing";

vi.mock("electron", () => {
  // ServiceHost's module graph touches Electron at import; nothing of it is
  // exercised here.
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});

// Avoid probing Docker and installed shells; settings persistence and emitters are real.
vi.mock("../../services/providers/exec-backend-service", () => ({
  clearBackendProbeCache: () => {},
  resolveBackend: () => "local",
  backendStatuses: () => [],
}));
vi.mock("../../services/workspace/terminal-shells", () => ({
  effectiveTerminalShell: () => "system",
  terminalShellStatuses: () => [],
}));

const { ServiceHost } = await import("../../service-host");
const previousHome = process.env.ABACUSAI_BOT_HOME;
let home: string;
const connections: InProcessConnection[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "settings-events-"));
  process.env.ABACUSAI_BOT_HOME = home;
});
afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
  vi.restoreAllMocks();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const bus = new MainEventBus();
  const events: IpcEvent[] = [];
  const host = Object.assign(Object.create(ServiceHost.prototype), {
    eventDispatcher: (event: IpcEvent) => {
      events.push(event);
      bus.dispatch(event);
    },
  });
  const deps = fakeDeps({
    bus,
    serviceHost: {
      setExecBackend: host.setExecBackend.bind(host),
      getExecBackendState: host.getExecBackendState.bind(host),
      setTerminalShell: host.setTerminalShell.bind(host),
    },
  });
  const connect = (
    webContentsId: number,
    flowWindow?: number,
    onServerMessage?: (message: unknown) => void
  ) => {
    const connection = connectInProcess(
      deps,
      { webContentsId },
      { flowWindow, onServerMessage }
    );
    connections.push(connection);
    return connection.client;
  };
  return { bus, host, events, connect };
};

describe("settings execution invalidations", () => {
  it("publishes the persisted backend for backend and shell changes, including fallback", () => {
    const { host, events } = setup();
    host.setExecBackend("local");
    host.setTerminalShell("system");
    expect(events).toEqual([]);
    expect(host.setExecBackend("docker")).toMatchObject({
      selected: "docker",
      effective: "local",
    });
    expect(readExecBackend()).toBe("docker");
    host.setTerminalShell("pwsh");
    expect(readTerminalShell()).toBe("pwsh");
    expect(events).toMatchObject([
      {
        type: "exec-backend",
        backend: "docker",
        emittedAt: expect.any(String),
      },
      {
        type: "exec-backend",
        backend: "docker",
        emittedAt: expect.any(String),
      },
    ]);
    host.setExecBackend("docker");
    host.setTerminalShell("pwsh");
    expect(events).toHaveLength(2);
  });

  it("does not publish a failed settings write", () => {
    const { host, events } = setup();
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("write failed");
    });
    expect(() => host.setExecBackend("docker")).toThrow("write failed");
    expect(() => host.setTerminalShell("pwsh")).toThrow("write failed");
    expect(events).toEqual([]);
  });

  it("delivers mutations from one window to both settings streams", async () => {
    const { bus, connect } = setup();
    const first = connect(1);
    const second = connect(2);
    const baseline = bus.listenerCount();
    const iterators = await Promise.all([
      first.settings.events(),
      second.settings.events(),
    ]);
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 2));
    await first.settings.execBackend.set({ backend: "docker" });
    for (const iterator of iterators) {
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: "exec-backend", backend: "docker" },
      });
    }
    await first.terminal.shell.set({ shell: "pwsh" });
    for (const iterator of iterators) {
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: "exec-backend", backend: "docker" },
      });
    }
    for (const iterator of iterators) await iterator.return();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
  });

  it("coalesces backend notices independently of credentials for a parked window", async () => {
    const { bus, connect } = setup();
    let sent = 0;
    const client = connect(2, 1, (message) => {
      const decoded =
        typeof message === "string" ? JSON.parse(message) : message;
      if ((decoded as { t?: number })?.t === 3) sent += 1;
    });
    const baseline = bus.listenerCount();
    const iterator = await client.settings.events();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline + 1));
    const at = new Date(0).toISOString();
    bus.dispatch({ type: "exec-backend", backend: "local", emittedAt: at });
    await vi.waitFor(() => expect(sent).toBe(1));
    for (let i = 0; i < 100; i += 1) {
      bus.dispatch({
        type: "exec-backend",
        backend: i % 2 === 0 ? "local" : "docker",
        emittedAt: at,
      });
    }
    bus.dispatch({
      type: "credentials-changed",
      provider: "openai",
      configured: true,
      emittedAt: at,
    });
    bus.dispatch({
      type: "credentials-changed",
      provider: "openai",
      configured: false,
      emittedAt: at,
    });
    bus.dispatch({
      type: "credentials-changed",
      provider: "anthropic",
      configured: true,
      emittedAt: at,
    });
    bus.dispatch({ type: "bots-updated", emittedAt: at });
    expect(sent).toBe(1);
    const values = [];
    for (let i = 0; i < 4; i += 1) values.push((await iterator.next()).value);
    expect(values).toEqual([
      { type: "exec-backend", backend: "local" },
      { type: "exec-backend", backend: "docker" },
      { type: "credentials-changed", provider: "openai", configured: false },
      { type: "credentials-changed", provider: "anthropic", configured: true },
    ]);
    await iterator.return();
    await vi.waitFor(() => expect(bus.listenerCount()).toBe(baseline));
  });
});
