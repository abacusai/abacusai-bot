/**
 * A Chrome tab behind the page surface the browser tools drive: URL, title,
 * loading and history come from the tab's CDP events; navigation, history
 * moves and screenshots go out as CDP commands.
 */
import { describe, expect, it, vi } from "vitest";

import { ChromePage } from "./chrome-page";
import type { ChromeRelay } from "./chrome-relay";

/** The relay as the page sees it: attached, answering CDP from a script. */
const fakeRelay = (
  answer: (
    method: string,
    params?: Record<string, unknown>
  ) => unknown = () => ({})
) => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const relay = {
    isAttached: () => true,
    cdp: vi.fn(
      async (
        _tabId: number,
        method: string,
        params?: Record<string, unknown>
      ) => {
        calls.push([method, params]);
        return answer(method, params);
      }
    ),
  } as unknown as ChromeRelay;
  return { relay, calls };
};

const history = (index: number, count: number) => ({
  currentIndex: index,
  entries: Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    url: `https://h.test/${i}`,
  })),
});

describe("ChromePage", () => {
  it("starts from what the extension knew of the tab", () => {
    const { relay } = fakeRelay();
    const page = new ChromePage(relay, {
      id: 7,
      url: "https://a.test/",
      title: "A",
    });

    expect(page.id).toBe(7);
    expect(page.getURL()).toBe("https://a.test/");
    expect(page.getTitle()).toBe("A");
    expect(page.isLoading()).toBe(false);
    expect(page.isDestroyed()).toBe(false);
    expect(page.debugger.isAttached()).toBe(true);
  });

  it("enables the page domain once, then navigates and reports where it went", async () => {
    const { relay, calls } = fakeRelay((method) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main", url: "https://a.test/" } } };
      if (method === "Page.navigate") return { frameId: "main" };
      if (method === "Runtime.evaluate") return { result: { value: "Landed" } };
      if (method === "Page.getNavigationHistory") return history(1, 2);
      return {};
    });
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });

    await page.loadURL("https://b.test/");
    expect(page.isLoading()).toBe(true);
    page.onCdpEvent("Page.frameNavigated", {
      frame: { id: "main", url: "https://b.test/" },
    });
    page.onCdpEvent("Page.loadEventFired", { timestamp: 1 });
    await vi.waitFor(() => expect(page.getTitle()).toBe("Landed"));

    expect(page.getURL()).toBe("https://b.test/");
    expect(page.isLoading()).toBe(false);
    expect(page.canGoBack()).toBe(true);
    expect(page.canGoForward()).toBe(false);
    expect(
      calls.map(([m]) => m).filter((m) => m === "Page.enable")
    ).toHaveLength(1);
    expect(calls.find(([m]) => m === "Page.navigate")?.[1]).toEqual({
      url: "https://b.test/",
    });

    await page.loadURL("https://c.test/");
    expect(calls.filter(([m]) => m === "Page.enable")).toHaveLength(1);
  });

  it("reports a navigation Chrome refused the way the built-in view does", async () => {
    const { relay } = fakeRelay((method) =>
      method === "Page.navigate"
        ? { errorText: "net::ERR_NAME_NOT_RESOLVED" }
        : {}
    );
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });
    const failed = vi.fn();
    page.on("did-fail-load", failed);

    await expect(page.loadURL("https://nope.invalid/")).rejects.toThrow(
      /ERR_NAME_NOT_RESOLVED/
    );

    expect(failed).toHaveBeenCalledWith(
      {},
      -2,
      "net::ERR_NAME_NOT_RESOLVED",
      "https://nope.invalid/",
      true
    );
    // The error page is served at the requested URL, as Chromium does it.
    expect(page.getURL()).toBe("https://nope.invalid/");
    expect(page.isLoading()).toBe(false);
    page.off("did-fail-load", failed);
  });

  it("ignores loading events of child frames", async () => {
    const { relay } = fakeRelay((method) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main", url: "https://a.test/" } } }
        : {}
    );
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });
    await page.prime();

    page.onCdpEvent("Page.frameStartedLoading", { frameId: "iframe-1" });
    expect(page.isLoading()).toBe(false);
    page.onCdpEvent("Page.frameNavigated", {
      frame: { id: "iframe-1", parentId: "main", url: "https://ad.test/" },
    });
    expect(page.getURL()).toBe("https://a.test/");
    page.onCdpEvent("Page.frameStartedLoading", { frameId: "main" });
    expect(page.isLoading()).toBe(true);
  });

  it("goes back through the navigation history entry", async () => {
    const { relay, calls } = fakeRelay((method) =>
      method === "Page.getNavigationHistory" ? history(1, 2) : {}
    );
    const page = new ChromePage(relay, { id: 7, url: "https://h.test/1" });

    page.goBack();
    await vi.waitFor(() =>
      expect(
        calls.find(([m]) => m === "Page.navigateToHistoryEntry")?.[1]
      ).toEqual({ entryId: 1 })
    );
    expect(page.isLoading()).toBe(true);
  });

  it("screenshots through CDP as JPEG", async () => {
    const { relay, calls } = fakeRelay((method) =>
      method === "Page.captureScreenshot"
        ? { data: Buffer.from("jpegbytes").toString("base64") }
        : {}
    );
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });

    const image = await page.capturePage();

    expect(image.toJPEG(70).toString()).toBe("jpegbytes");
    expect(calls.find(([m]) => m === "Page.captureScreenshot")?.[1]).toEqual({
      format: "jpeg",
      quality: 70,
    });
  });

  it("forwards debugger commands to its tab", async () => {
    const { relay } = fakeRelay(() => ({ result: { value: 42 } }));
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });

    await expect(
      page.debugger.sendCommand("Runtime.evaluate", { expression: "6*7" })
    ).resolves.toEqual({
      result: { value: 42 },
    });
    expect(relay.cdp).toHaveBeenCalledWith(7, "Runtime.evaluate", {
      expression: "6*7",
    });
  });

  it("is destroyed once the tab is gone", () => {
    const { relay } = fakeRelay();
    const page = new ChromePage(relay, { id: 7, url: "https://a.test/" });
    page.markDestroyed();
    expect(page.isDestroyed()).toBe(true);
  });
});
