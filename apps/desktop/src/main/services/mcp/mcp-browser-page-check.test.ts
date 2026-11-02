/**
 * `checkServedPage`: `present_deliverable`'s proof that a local app runs.
 *
 * The browser is a fake whose tabs record what was done to them and whose
 * page answers `Runtime.evaluate` from a script. What is held here is the
 * decision: an app that throws, or does not load, is reported so; one the
 * check could not see is "unknown" (null), never "clean"; and the tab the
 * check opened is gone afterwards, also when its caller's budget ran out.
 */
import { describe, expect, it, vi } from "vitest";

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

/**
 * A browser whose one page threw `errors`, failed to load with `fails`,
 * landed on another origin, or `stalls`: its document never arrives.
 */
const browser = (
  options: {
    errors?: string[] | null;
    fails?: string;
    lands?: string;
    stalls?: boolean;
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
      if (options.stalls === true && url === URL_SERVED)
        return new Promise<void>(() => {});
      if (options.fails != null && url === URL_SERVED) {
        for (const listener of failListeners)
          listener({}, -102, options.fails, url, true);
        throw new Error(options.fails);
      }
      tabs.get(id)!.url = url;
    },
    debugger: {
      isAttached: () => true,
      attach: () => {},
      sendCommand: (method: string, params?: { expression?: string }) => {
        log.push(method);
        if (
          method === "Runtime.evaluate" &&
          params?.expression?.includes("__abacusPageErrors") === true
        )
          return options.stalls === true
            ? new Promise(() => {})
            : Promise.resolve({
                result: {
                  value: {
                    origin: options.lands ?? new URL(tabs.get(id)!.url).origin,
                    caught: options.errors ?? [],
                  },
                },
              });
        return Promise.resolve({ result: { value: null } });
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
  };
  const server = new McpBrowserServer({ target: () => source as never });
  return { server, log, tabs };
};

const unlimited = (): AbortSignal => new AbortController().signal;

describe("checking a served page before it is handed over", () => {
  it("installs the error collector before the page loads, and closes its tab", async () => {
    const { server, log, tabs } = browser();

    expect(
      await server.checkServedPage(URL_SERVED, SESSION, unlimited())
    ).toEqual({
      loaded: true,
      errors: [],
    });
    // Without Page.enable a new-document script is never injected.
    expect(log.indexOf("Page.enable")).toBeLessThan(
      log.indexOf("Page.addScriptToEvaluateOnNewDocument")
    );
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

    expect(
      await server.checkServedPage(URL_SERVED, SESSION, unlimited())
    ).toEqual({
      loaded: true,
      errors: ["Uncaught TypeError: player is undefined"],
    });
  });

  it("reports a page that did not load at all", async () => {
    const { server, tabs } = browser({ fails: "ERR_CONNECTION_REFUSED" });

    expect(
      await server.checkServedPage(URL_SERVED, SESSION, unlimited())
    ).toEqual({
      loaded: false,
      reason: "ERR_CONNECTION_REFUSED (-102)",
    });
    expect(tabs.size).toBe(0);
  });

  it("knows nothing (null) when the page went elsewhere or no browser is there", async () => {
    expect(
      await browser({
        lands: "https://elsewhere.example",
      }).server.checkServedPage(URL_SERVED, SESSION, unlimited())
    ).toBeNull();
    expect(
      await new McpBrowserServer({ target: () => null }).checkServedPage(
        URL_SERVED,
        SESSION,
        unlimited()
      )
    ).toBeNull();
  });

  it("opens nothing that is not on this computer", async () => {
    const { server, log } = browser();

    expect(
      await server.checkServedPage(
        "http://169.254.169.254/",
        SESSION,
        unlimited()
      )
    ).toBeNull();
    expect(log).toEqual([]);
  });

  it("stops and closes its tab when its caller's budget runs out", async () => {
    const { server, log, tabs } = browser({ stalls: true });
    const budget = new AbortController();

    const check = server.checkServedPage(URL_SERVED, SESSION, budget.signal);
    await vi.waitFor(() => expect(log).toContain(`load ${URL_SERVED}`));
    budget.abort();

    expect(await check).toBeNull();
    expect(tabs.size).toBe(0);
  });
});
