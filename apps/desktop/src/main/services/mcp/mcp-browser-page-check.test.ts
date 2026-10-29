/**
 * `checkServedPage`: `present_deliverable`'s proof that a local app runs.
 *
 * The browser is a fake whose tabs record what was done to them and whose
 * page answers `Runtime.evaluate` from a script. What is held here is the
 * decision: an app that throws, or does not load, is reported so; one the
 * check could not see is "unknown" (null), never "clean"; and the tab the
 * check opened is gone afterwards.
 */
import { describe, expect, it } from "vitest";

import { McpBrowserServer } from "./mcp-browser-server";

const SESSION = "session-1";
const URL_SERVED = "http://127.0.0.1:4321/";

type FailLoad = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedURL: string,
  isMainFrame: boolean
) => void;

/** A browser whose one page threw `errors`, or failed to load with `fails`. */
const browser = (
  options: {
    errors?: string[] | null;
    fails?: string;
    lands?: string;
  } = {}
) => {
  const log: string[] = [];
  const tabs = new Map<number, { owner: string; url: string }>();
  const failListeners = new Set<FailLoad>();
  let next = 1;
  const page = (id: number) => ({
    id,
    isDestroyed: () => !tabs.has(id),
    isLoading: () => false,
    getURL: () => tabs.get(id)?.url ?? "",
    getTitle: () => "",
    on: (_event: string, listener: FailLoad) => failListeners.add(listener),
    off: (_event: string, listener: FailLoad) => failListeners.delete(listener),
    loadURL: async (url: string) => {
      log.push(`load ${url}`);
      if (options.fails != null) {
        for (const listener of failListeners)
          listener({}, -102, options.fails, url, true);
        throw new Error(options.fails);
      }
      tabs.get(id)!.url = url;
    },
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (method: string, params?: { expression?: string }) => {
        log.push(method);
        if (
          method === "Runtime.evaluate" &&
          params?.expression?.includes("__abacusPageErrors") === true
        )
          return { result: { value: options.errors ?? [] } };
        return { result: { value: null } };
      },
    },
  });
  const source = {
    candidates: () => [],
    webContents: (id: number) => (tabs.has(id) ? page(id) : null),
    materialize: async (owner: string, url: string) => {
      log.push(`open ${url}`);
      tabs.set(next, { owner, url });
      return next++;
    },
    sessionTabs: (owner: string) =>
      [...tabs]
        .filter(([, tab]) => tab.owner === owner)
        .map(([id]) => ({ id })),
    closeTab: async (_owner: string, id: number) => tabs.delete(id),
    releaseSession: () => {},
    liveOrigin: async (id: number) =>
      options.lands ?? new URL(tabs.get(id)!.url).origin,
  };
  const server = new McpBrowserServer({ target: () => source as never });
  return { server, log, tabs };
};

describe("checking a served page before it is handed over", () => {
  it("installs the error collector before the page loads, and closes its tab", async () => {
    const { server, log, tabs } = browser();

    expect(await server.checkServedPage(URL_SERVED, SESSION)).toEqual({
      loaded: true,
      errors: [],
    });
    expect(log.indexOf("Page.addScriptToEvaluateOnNewDocument")).toBeLessThan(
      log.indexOf(`load ${URL_SERVED}`)
    );
    expect(log.indexOf("Network.setBlockedURLs")).toBeLessThan(
      log.indexOf(`load ${URL_SERVED}`)
    );
    expect(tabs.size).toBe(0);
  });

  it("reports what the page threw", async () => {
    const { server } = browser({
      errors: ["Uncaught TypeError: player is undefined"],
    });

    expect(await server.checkServedPage(URL_SERVED, SESSION)).toEqual({
      loaded: true,
      errors: ["Uncaught TypeError: player is undefined"],
    });
  });

  it("reports a page that did not load at all", async () => {
    const { server, tabs } = browser({ fails: "ERR_CONNECTION_REFUSED" });

    expect(await server.checkServedPage(URL_SERVED, SESSION)).toEqual({
      loaded: false,
      reason: "ERR_CONNECTION_REFUSED (-102)",
    });
    expect(tabs.size).toBe(0);
  });

  it("knows nothing (null) when the page went elsewhere or no browser is there", async () => {
    expect(
      await browser({
        lands: "https://elsewhere.example",
      }).server.checkServedPage(URL_SERVED, SESSION)
    ).toBeNull();
    expect(
      await new McpBrowserServer({ target: () => null }).checkServedPage(
        URL_SERVED,
        SESSION
      )
    ).toBeNull();
  });

  it("opens nothing that is not on this computer", async () => {
    const { server, log } = browser();

    expect(
      await server.checkServedPage("http://169.254.169.254/", SESSION)
    ).toBeNull();
    expect(log).toEqual([]);
  });
});
