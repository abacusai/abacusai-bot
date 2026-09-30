/**
 * Keep-awake (spec 07 review r1 #10, review r1 finding 11): the legacy
 * renderer's busy report lives only as long as the document that made it,
 * and main's busy source is followed from its current value.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const started = new Set<number>();
  let next = 1;
  return {
    handlers,
    started,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    },
    powerSaveBlocker: {
      start: () => {
        const id = next++;
        started.add(id);
        return id;
      },
      stop: (id: number) => {
        started.delete(id);
      },
      isStarted: (id: number) => started.has(id),
    },
  };
});
vi.mock("electron", () => ({
  ipcMain: electron.ipcMain,
  powerSaveBlocker: electron.powerSaveBlocker,
}));
vi.mock("electron-store", () => ({
  default: class {
    get(_key: string, fallback: unknown) {
      return fallback;
    }
    set() {}
  },
}));

const load = async () => {
  vi.resetModules();
  electron.handlers.clear();
  electron.started.clear();
  const module = await import("./keep-awake");
  module.registerKeepAwakeHandlers();
  return module;
};

class FakeSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

const report = (sender: FakeSender, busy: boolean) =>
  electron.handlers.get("power:set-agent-busy")!({ sender }, busy);
const blocking = () => electron.started.size > 0;

describe("keep-awake", () => {
  for (const [name, end] of [
    ["destroyed", (sender: FakeSender) => sender.emit("destroyed")],
    [
      "render-process-gone",
      (sender: FakeSender) =>
        sender.emit("render-process-gone", {}, { reason: "crashed" }),
    ],
    [
      "a main-frame navigation (reload or swap)",
      (sender: FakeSender) =>
        sender.emit("did-start-navigation", {}, "app://x", false, true),
    ],
  ] as const) {
    it(`a legacy busy report is dropped on ${name}`, async () => {
      await load();
      const sender = new FakeSender(7);
      report(sender, true);
      expect(blocking()).toBe(true);
      end(sender);
      expect(blocking()).toBe(false);
    });
  }

  it("an in-page or sub-frame navigation keeps the report; another sender's report is its own", async () => {
    await load();
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    report(a, true);
    a.emit("did-start-navigation", {}, "app://x#y", true, true);
    a.emit("did-start-navigation", {}, "https://frame", false, false);
    expect(blocking()).toBe(true);
    report(b, false);
    expect(blocking()).toBe(true);
    a.emit("destroyed");
    expect(blocking()).toBe(false);
  });

  it("follows main's busy source from the value it already has", async () => {
    const { followMainAgentBusy } = await load();
    const listeners = new Set<(busy: boolean) => void>();
    const source = {
      busy: true,
      onBusyChange: (listener: (busy: boolean) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    followMainAgentBusy(source);
    expect(blocking()).toBe(true);
    for (const listener of listeners) listener(false);
    expect(blocking()).toBe(false);
  });
});
