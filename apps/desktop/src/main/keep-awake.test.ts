/**
 * Keep-awake (spec 07 review r1 #10, review r1 finding 11): the legacy
 * renderer's busy report lives only as long as the document that made it,
 * and main's busy source is followed from its current value.
 */

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
  return module;
};

const blocking = () => electron.started.size > 0;
describe("keep-awake", () => {
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
