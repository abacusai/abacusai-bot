/**
 * The motion render window's preload holds the encoder and nothing else: the
 * page is the model's content and must reach no bridge, no RPC, no host API.
 */
import { describe, expect, it, vi } from "vitest";

const handlers = new Map<string, unknown>();
const exposed = new Map<string, unknown>();

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) =>
      exposed.set(name, value),
  },
  ipcRenderer: {
    on: (channel: string, handler: unknown) => handlers.set(channel, handler),
    send: vi.fn(),
    sendSync: () => ({}),
    invoke: vi.fn(),
    removeListener: vi.fn(),
    postMessage: vi.fn(),
    getMaxListeners: () => 64,
    setMaxListeners: vi.fn(),
  },
  webUtils: { getPathForFile: () => "" },
}));

describe("motion encoder preload", () => {
  it("is what the motion window gets, and it exposes nothing to the page", async () => {
    const argv = process.argv;
    process.argv = [...argv, "--abacus-window=motion"];
    try {
      await import("./index");
    } finally {
      process.argv = argv;
    }
    expect([...handlers.keys()].sort()).toEqual([
      "motion:finish",
      "motion:frame",
      "motion:start",
    ]);
    expect(exposed.size).toBe(0);
  });
});
