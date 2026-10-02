/** Both window kinds expose only abacusHost after the port handshake. */
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
  it.each(["main", "notch"] as const)(
    "%s exposes only abacusHost after the handshake",
    async (kind) => {
      exposed.clear();
      order.length = 0;
      windowListeners.length = 0;
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

      const { installMainPreload } = await import("./main-preload");
      installMainPreload(kind);

      expect(windowListeners).toEqual(["message"]);
      // The handshake listener exists before anything reaches the page.
      expect(order[0]).toBe("listen:message");
      expect([...exposed.keys()]).toEqual(["abacusHost"]);
      const host = exposed.get("abacusHost") as {
        getPathForFile: (file: unknown) => string;
      };
      expect(host.getPathForFile({})).toBe("/tmp/picked.txt");

      vi.unstubAllGlobals();
    }
  );
});
