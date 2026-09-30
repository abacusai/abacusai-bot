/**
 * A-T4, the preload as a whole: installing the port handshake leaves the
 * legacy `window.api` exposed exactly as before, adds `abacusHost`, and wires
 * the handshake before anything is exposed.
 */
import { describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const order: string[] = [];
const windowListeners: string[] = [];

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => {
      order.push(`expose:${name}`);
      exposed.set(name, value);
    },
  },
  ipcRenderer: {
    sendSync: () => ({ theme: "dark" }),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    postMessage: vi.fn(),
    getMaxListeners: () => 64,
    setMaxListeners: vi.fn(),
  },
  webUtils: { getPathForFile: () => "/tmp/picked.txt" },
}));

describe("the preload (A-T4)", () => {
  it("still exposes window.api, and adds abacusHost after the handshake", async () => {
    const fakeWindow = {
      addEventListener: (type: string) => {
        order.push(`listen:${type}`);
        windowListeners.push(type);
      },
      postMessage: vi.fn(),
    };
    vi.stubGlobal("window", fakeWindow);
    Object.defineProperty(process, "contextIsolated", {
      value: true,
      configurable: true,
    });

    await import("./index");

    expect(windowListeners).toEqual(["message"]);
    // The handshake listener exists before anything reaches the page.
    expect(order[0]).toBe("listen:message");
    expect(order).toContain("expose:api");
    expect(order).toContain("expose:abacusHost");

    const api = exposed.get("api") as Record<string, unknown>;
    expect(typeof api.agent).toBe("object");
    expect(typeof api.openFolderDialog).toBe("function");
    expect(typeof api.getPathForFile).toBe("function");
    expect(api.durableState).toMatchObject({ snapshot: { theme: "dark" } });

    const host = exposed.get("abacusHost") as {
      getPathForFile: (file: unknown) => string;
    };
    expect(host.getPathForFile({})).toBe("/tmp/picked.txt");

    vi.unstubAllGlobals();
  });
});
