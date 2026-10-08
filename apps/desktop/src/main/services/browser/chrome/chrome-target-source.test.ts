/**
 * Chrome's tabs as the browser tools' target source: a session gets its own
 * tab, the user's picked tab belongs to nobody, and tabs that leave the group
 * stop being offered.
 */
import { EventEmitter } from "node:events";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { pickBrowserTarget } from "../browser-target";
import {
  FIND_SECRET_FIELDS_SCRIPT,
  MASK_FOR_CAPTURE_SCRIPT,
  UNMASK_SCRIPT,
} from "../secret-fields";
import { SESSION_TABS_KEPT_MS, UNCLAIMED_TAB_GRACE_MS } from "./browser-tabs";
import type { ChromeRelay, ChromeTabInfo } from "./chrome-relay";
import { ChromeTargetSource } from "./chrome-target-source";

class FakeRelay extends EventEmitter {
  connected = true;
  /** As the hosted Chromium; the user's Chrome is `false`. */
  ownsTabs = true;
  tabs = new Map<number, ChromeTabInfo>();
  attached = new Set<number>();
  next = 100;
  cdp = vi.fn(
    async (
      _tabId: number,
      method: string,
      _params?: unknown
    ): Promise<unknown> =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "main" } } }
        : {}
  );
  tab(id: number) {
    return this.tabs.get(id);
  }
  isAttached(id: number) {
    return this.attached.has(id);
  }
  attachedTabs() {
    return [...this.attached].map((id) => this.tabs.get(id)!);
  }
  async createTab(url: string) {
    const tab = { id: this.next++, url };
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
    this.emit("tabAttached", tab);
    return tab;
  }
  closeTab = vi.fn(async (id: number) => {
    this.attached.delete(id);
    this.tabs.delete(id);
    this.emit("tabRemoved", id);
  });
  detachTab = vi.fn(async (id: number) => {
    this.attached.delete(id);
    this.emit("tabDetached", id);
  });
  /** A page the browser opened by itself (a popup), attached as the driver does. */
  open(tab: ChromeTabInfo) {
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
    this.emit("tabAttached", tab);
  }
  /** What the extension does when the user allows a tab. */
  allow(tab: ChromeTabInfo) {
    this.tabs.set(tab.id, tab);
    this.attached.add(tab.id);
  }
}

const setup = () => {
  const clock = { now: 1_000_000 };
  const relay = new FakeRelay();
  const source = new ChromeTargetSource(relay as unknown as ChromeRelay, {
    now: () => clock.now,
  });
  return { relay, source, clock };
};

describe("ChromeTargetSource", () => {
  it("offers the attached tabs, the user's own without an owner", () => {
    const { relay, source } = setup();
    relay.allow({ id: 7, url: "https://picked.test/", active: true });

    expect(source.candidates()).toEqual([
      { id: 7, url: "https://picked.test/", sessionId: null, presented: true },
    ]);
    // A session drives only its own tabs, so it gets none of this one.
    expect(
      pickBrowserTarget(source.candidates(), { id: null, url: null }, "s1")
    ).toBeNull();
    // A caller with no session takes the tab on screen.
    expect(
      pickBrowserTarget(source.candidates(), { id: null, url: null }, null)
    ).toBe(7);
  });

  it("makes a session its own tab and remembers whose it is", async () => {
    const { relay, source } = setup();

    const id = await source.materialize("s1", "https://start.test/");

    expect(id).toBe(100);
    expect(source.candidates()).toEqual([
      {
        id: 100,
        url: "https://start.test/",
        sessionId: "s1",
        presented: false,
        current: true,
      },
    ]);
    expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100]);
    expect(source.webContents(100)?.getURL()).toBe("https://start.test/");
    // The page's domains were enabled so its events flow from the start.
    expect(relay.cdp).toHaveBeenCalledWith(100, "Page.enable");
  });

  it("routes a tab's CDP events to its page", async () => {
    const { relay, source } = setup();
    await source.materialize("s1", "https://start.test/");
    const page = source.webContents(100)!;

    relay.emit("cdpEvent", 100, "Page.frameNavigated", {
      frame: { id: "main", url: "https://next.test/" },
    });

    expect(page.getURL()).toBe("https://next.test/");
  });

  it("drops a tab that left the group or closed", async () => {
    const { relay, source } = setup();
    await source.materialize("s1", "https://start.test/");
    const page = source.webContents(100)!;

    relay.attached.delete(100);
    relay.emit("tabDetached", 100);

    expect(page.isDestroyed()).toBe(true);
    expect(source.candidates()).toEqual([]);
    expect(source.webContents(100)).toBeNull();
    expect(source.sessionTabs("s1")).toEqual([]);
  });

  describe("tabs a session's page opens", () => {
    it("drives a popup its page opened, and goes back to the opener when it closes", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://flights.test/");
      // The tools remember the opener; the popup still wins.
      const memory = { id: 100, url: "https://flights.test/" };

      relay.open({ id: 7, url: "https://airline.test/book", openerTabId: 100 });

      expect(pickBrowserTarget(source.candidates(), memory, "s1")).toBe(7);
      expect(source.sessionTabs("s1")).toEqual([
        expect.objectContaining({ id: 100, current: false, openerId: null }),
        expect.objectContaining({ id: 7, current: true, openerId: 100 }),
      ]);
      // Another session's popup is never this session's.
      expect(pickBrowserTarget(source.candidates(), memory, "s2")).toBeNull();

      relay.emit("tabRemoved", 7);

      expect(pickBrowserTarget(source.candidates(), memory, "s1")).toBe(100);
      expect(source.sessionTabs("s1")).toEqual([
        expect.objectContaining({ id: 100, current: true }),
      ]);
    });

    it("takes an opener-less tab opened within the window after the session's click, and no other", async () => {
      const { relay, source, clock } = setup();
      await source.materialize("s1", "https://flights.test/");

      relay.open({ id: 8, url: "https://stray.test/" });
      expect(source.candidates().find((tab) => tab.id === 8)?.sessionId).toBe(
        null
      );

      source.noteAction("s1");
      clock.now += 2_000;
      relay.open({ id: 9, url: "https://airline.test/" });
      expect(
        source.sessionTabs("s1").map((tab) => [tab.id, tab.current])
      ).toEqual([
        [100, false],
        [9, true],
      ]);

      clock.now += 3_001;
      relay.open({ id: 10, url: "https://late.test/" });
      expect(source.candidates().find((tab) => tab.id === 10)?.sessionId).toBe(
        null
      );
    });

    it("switches and closes on request, and only the session's own tabs", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://a.test/");
      relay.open({ id: 7, url: "https://b.test/", openerTabId: 100 });

      expect(await source.activateTab("s1", 100)).toBe(true);
      expect(
        pickBrowserTarget(source.candidates(), { id: 7, url: null }, "s1")
      ).toBe(100);
      expect(await source.activateTab("s2", 7)).toBe(false);
      expect(await source.closeTab("s2", 7)).toBe(false);
      expect(relay.closeTab).not.toHaveBeenCalled();

      expect(await source.closeTab("s1", 7)).toBe(true);
      expect(relay.closeTab).toHaveBeenCalledWith(7);
      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100]);
    });

    it("keeps at most six tabs, closing the oldest off the active tab's opener chain", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://0.test/");
      // 100 opens 1, which opens 2; 3..5 come from 100 too.
      relay.open({ id: 1, url: "https://1.test/", openerTabId: 100 });
      relay.open({ id: 2, url: "https://2.test/", openerTabId: 1 });
      for (const id of [3, 4, 5])
        relay.open({ id, url: `https://${id}.test/`, openerTabId: 100 });
      expect(relay.closeTab).not.toHaveBeenCalled();
      // The seventh opens from 2, so 100 → 1 → 2 → 6 is the chain to keep.
      await source.activateTab("s1", 2);
      relay.open({ id: 6, url: "https://6.test/", openerTabId: 2 });

      await vi.waitFor(() => expect(relay.closeTab).toHaveBeenCalledWith(3));
      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([
        100, 1, 2, 4, 5, 6,
      ]);
    });

    it("keeps an ended session's tabs for it to come back to, then closes them, and nobody else's", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { relay, source } = setup();
        await source.materialize("s1", "https://a.test/");
        relay.open({ id: 7, url: "https://b.test/", openerTabId: 100 });
        await source.materialize("s2", "https://c.test/");

        // The agent stopped, and came back within the hold: nothing closes.
        source.releaseSession("s1");
        await vi.advanceTimersByTimeAsync(SESSION_TABS_KEPT_MS - 1);
        source.noteUse("s1");
        await vi.advanceTimersByTimeAsync(SESSION_TABS_KEPT_MS);
        expect(relay.closeTab).not.toHaveBeenCalled();
        expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100, 7]);

        // Ended for good: its tabs close once the hold runs out.
        source.releaseSession("s1");
        await vi.advanceTimersByTimeAsync(SESSION_TABS_KEPT_MS);
        expect(
          relay.closeTab.mock.calls.map(([id]) => id).sort((a, b) => a - b)
        ).toEqual([7, 100]);
        expect(source.sessionTabs("s2").map((tab) => tab.id)).toEqual([101]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("in the user's own Chrome lets an ended session's tabs go without closing them", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { relay, source } = setup();
        relay.ownsTabs = false;
        await source.materialize("s1", "https://a.test/");

        source.releaseSession("s1");
        await vi.advanceTimersByTimeAsync(SESSION_TABS_KEPT_MS);

        expect(relay.closeTab).not.toHaveBeenCalled();
        expect(relay.detachTab).toHaveBeenCalledWith(100);
        expect(source.sessionTabs("s1")).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("closes a tab no session claimed after a grace in its own browser, and only detaches one in the user's", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const own = setup();
        own.relay.open({ id: 8, url: "https://stray.test/" });
        await vi.advanceTimersByTimeAsync(UNCLAIMED_TAB_GRACE_MS);
        expect(own.relay.closeTab).toHaveBeenCalledWith(8);

        const users = setup();
        users.relay.ownsTabs = false;
        // The tab the user picked was handed over during the handshake: never let go.
        users.relay.open({
          id: 7,
          url: "https://picked.test/",
          preexisting: true,
        });
        users.relay.open({ id: 9, url: "https://stray.test/" });
        await vi.advanceTimersByTimeAsync(UNCLAIMED_TAB_GRACE_MS);
        expect(users.relay.closeTab).not.toHaveBeenCalled();
        expect(users.relay.detachTab.mock.calls).toEqual([[9]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves an opener-less tab unowned when two sessions acted within the window, and adopts it after one", async () => {
      const { relay, source, clock } = setup();
      await source.materialize("s1", "https://a.test/");
      await source.materialize("s2", "https://b.test/");

      source.noteAction("s1");
      clock.now += 500;
      source.noteAction("s2");
      clock.now += 500;
      relay.open({ id: 8, url: "https://whose.test/" });
      expect(source.candidates().find((tab) => tab.id === 8)?.sessionId).toBe(
        null
      );

      clock.now += 5_000;
      source.noteAction("s2");
      clock.now += 500;
      relay.open({ id: 9, url: "https://mine.test/" });
      expect(source.candidates().find((tab) => tab.id === 9)?.sessionId).toBe(
        "s2"
      );
      // One action, one tab: the next opener-less tab is nobody's.
      relay.open({ id: 10, url: "https://next.test/" });
      expect(source.candidates().find((tab) => tab.id === 10)?.sessionId).toBe(
        null
      );
    });

    it("never gives a click a tab whose named opener nobody owns", async () => {
      const { relay, source } = setup();
      relay.allow({ id: 7, url: "https://picked.test/" });
      await source.materialize("s1", "https://a.test/");

      source.noteAction("s1");
      relay.open({ id: 8, url: "https://from-picked.test/", openerTabId: 7 });
      relay.open({ id: 9, url: "https://elsewhere.test/", hasOpener: true });

      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([100]);
    });

    it("keeps a popup that opens while another session's tab is being made, and skips only the made tab", async () => {
      const { relay, source } = setup();
      await source.materialize("s2", "https://b.test/");
      let finish: () => void = () => undefined;
      relay.createTab = async (url: string) => {
        const tab = { id: relay.next++, url };
        relay.open(tab);
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return tab;
      };

      const making = source.materialize("s1", "https://a.test/");
      await vi.waitFor(() => expect(relay.tabs.has(101)).toBe(true));
      // s2's page opens a popup, and s2 clicks something that opens an opener-less tab.
      relay.open({ id: 7, url: "https://popup.test/", openerTabId: 100 });
      source.noteAction("s2");
      relay.open({ id: 8, url: "https://noopener.test/" });
      expect(source.candidates().find((tab) => tab.id === 7)?.sessionId).toBe(
        "s2"
      );

      finish();
      expect(await making).toBe(101);
      expect(source.sessionTabs("s1").map((tab) => tab.id)).toEqual([101]);
      expect(source.sessionTabs("s2").map((tab) => tab.id)).toEqual([
        100, 7, 8,
      ]);
    });
    it("reads the live origin of a tab and of its frames", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/cart");
      relay.cdp.mockImplementation(async (_tabId: number, method: string) => {
        if (method === "Runtime.evaluate")
          return { result: { value: "https://shop.test" } };
        if (method === "Page.getFrameTree")
          return {
            frameTree: {
              frame: { id: "main", url: "https://shop.test/cart" },
              childFrames: [
                { frame: { id: "pay", url: "https://pay.test/card?x=1" } },
              ],
            },
          };
        return {};
      });

      expect(await source.tabs.origin(100)).toBe("https://shop.test");
      expect(await source.tabs.origin(100, "pay")).toBe("https://pay.test");
      expect(await source.tabs.origin(100, "gone")).toBeNull();
    });
  });

  describe("secret fields", () => {
    /**
     * A page over CDP: `fields` are the secret fields the in-page classifier
     * finds now, `connected` the nodes still in the document, `gone` nodes the
     * renderer no longer has. Methods in `overrides` answer instead.
     */
    const secretPage = (
      relay: FakeRelay,
      overrides: Partial<
        Record<string, (params: Record<string, unknown>) => unknown>
      > = {}
    ) => {
      const state = {
        fields: [] as number[],
        connected: new Set<number>(),
        gone: new Set<number>(),
        sent: [] as Array<{ method: string; params: Record<string, unknown> }>,
      };
      relay.cdp.mockImplementation(
        async (_tabId: number, method: string, raw?: unknown) => {
          const params = (raw ?? {}) as Record<string, unknown>;
          state.sent.push({ method, params });
          const override = overrides[method];
          if (override != null) return override(params);
          switch (method) {
            case "Runtime.evaluate":
              if (params.expression === FIND_SECRET_FIELDS_SCRIPT)
                return { result: { objectId: "found" } };
              if (params.expression === "location.origin")
                return { result: { value: "https://shop.test" } };
              if (params.expression === MASK_FOR_CAPTURE_SCRIPT)
                return { result: { value: 1 } };
              // A handle on one field (the one markFilled marked).
              if (params.returnByValue === false)
                return { result: { objectId: "node-12" } };
              return { result: { value: true } };
            case "Runtime.getProperties":
              return {
                result: [
                  ...state.fields.map((id, index) => ({
                    name: String(index),
                    value: { objectId: `node-${id}` },
                  })),
                  { name: "length", value: { value: state.fields.length } },
                ],
              };
            case "DOM.describeNode":
              return {
                node: {
                  backendNodeId: Number(
                    String(params.objectId).replace("node-", "")
                  ),
                },
              };
            case "DOM.resolveNode": {
              const id = params.backendNodeId as number;
              if (state.gone.has(id)) throw new Error("No node found");
              return { object: { objectId: `node-${id}` } };
            }
            case "Runtime.callFunctionOn": {
              const id = Number(String(params.objectId).replace("node-", ""));
              return String(params.functionDeclaration).includes("isConnected")
                ? { result: { value: state.connected.has(id) } }
                : { result: { value: "named" } };
            }
            case "Page.getFrameTree":
              return {
                frameTree: {
                  frame: { id: "main", securityOrigin: "https://shop.test" },
                  childFrames: [
                    {
                      frame: {
                        id: "same",
                        url: "about:blank",
                        securityOrigin: "https://shop.test",
                      },
                    },
                    {
                      frame: {
                        id: "card",
                        url: "https://pay.test/card",
                        securityOrigin: "https://pay.test",
                      },
                      childFrames: [
                        {
                          frame: {
                            id: "inner",
                            securityOrigin: "https://shop.test",
                          },
                        },
                      ],
                    },
                  ],
                },
              };
            case "DOM.getFrameOwner":
              return { backendNodeId: 7 };
            case "Page.captureScreenshot":
              return { data: Buffer.from("jpeg").toString("base64") };
            default:
              return {};
          }
        }
      );
      return state;
    };

    it("refuses scripts while the page has any secret field, empty or not, and remembers it outside the page", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/login");
      const page = source.webContents(100)!;
      const secrets = source.secrets(100)!;
      const state = secretPage(relay);

      expect(await secrets.executeRefusal(page)).toBeNull();

      // An empty password field appears: no script may wait in the page for it.
      state.fields = [11];
      state.connected.add(11);
      expect(await secrets.executeRefusal(page)).toContain("cannot run");

      // The page strips every mark, so the classifier no longer sees it; the
      // record is the tab's, and the mark is put back.
      state.fields = [];
      state.sent.length = 0;
      expect(await secrets.executeRefusal(page)).toContain("cannot run");
      expect(state.sent).toContainEqual({
        method: "DOM.resolveNode",
        params: expect.objectContaining({ backendNodeId: 11 }),
      });

      // Taken out of the document, then gone from the renderer: scripts run again.
      state.connected.delete(11);
      expect(await secrets.executeRefusal(page)).toBeNull();
      state.gone.add(11);
      expect(await secrets.executeRefusal(page)).toBeNull();
    });

    it("refuses scripts after a fill until the main frame navigates, which also forgets the known fields", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/login");
      const page = source.webContents(100)!;
      const secrets = source.secrets(100)!;
      const state = secretPage(relay);
      state.fields = [11];
      state.connected.add(11);
      await secrets.executeRefusal(page);
      state.fields = [];

      expect(await secrets.markFilled(page, "#password")).toBe(true);
      // The filled field joins the known ones, so its mark is put back too.
      state.sent.length = 0;
      await secrets.reassert(page);
      expect(state.sent).toContainEqual({
        method: "DOM.resolveNode",
        params: expect.objectContaining({ backendNodeId: 12 }),
      });
      state.connected.delete(11);
      expect(await secrets.executeRefusal(page)).toContain("cannot run");
      // A frame inside the page navigating is not the page leaving.
      relay.emit("cdpEvent", 100, "Page.frameNavigated", {
        frame: { id: "ad", parentId: "main", url: "https://ads.test/" },
      });
      expect(await secrets.executeRefusal(page)).not.toBeNull();

      relay.emit("cdpEvent", 100, "Page.frameNavigated", {
        frame: { id: "main", url: "https://shop.test/account" },
      });
      state.connected.add(11);
      state.sent.length = 0;
      expect(await secrets.executeRefusal(page)).toBeNull();
      expect(state.sent.map((call) => call.method)).not.toContain(
        "DOM.resolveNode"
      );
    });

    it("refuses scripts when the page cannot be asked", async () => {
      for (const overrides of [
        {
          "Runtime.evaluate": () => ({ exceptionDetails: { text: "blocked" } }),
        },
        { "DOM.describeNode": () => Promise.reject(new Error("no node")) },
      ]) {
        const { relay, source } = setup();
        await source.materialize("s1", "https://shop.test/login");
        const state = secretPage(relay, overrides);
        state.fields = [11];

        expect(
          await source.secrets(100)!.executeRefusal(source.webContents(100)!)
        ).toContain("cannot run");
      }
    });

    it("covers a cross-origin frame in every capture, before any fill, and shows the page again after", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/pay");
      const { sent } = secretPage(relay);

      expect(await source.captureMasked(100, source.secrets(100)!)).toEqual({
        data: Buffer.from("jpeg").toString("base64"),
        mimeType: "image/jpeg",
      });
      // Only the outermost frame of another origin is named; the one inside it goes with it.
      expect(
        sent
          .filter((call) => call.method === "DOM.getFrameOwner")
          .map((call) => call.params.frameId)
      ).toEqual(["card"]);
      const order = sent.map((call) =>
        call.method === "Runtime.evaluate"
          ? String(call.params.expression)
          : call.method
      );
      expect(order.indexOf(FIND_SECRET_FIELDS_SCRIPT)).toBeLessThan(
        order.indexOf(MASK_FOR_CAPTURE_SCRIPT)
      );
      expect(order.indexOf(MASK_FOR_CAPTURE_SCRIPT)).toBeLessThan(
        order.indexOf("Page.captureScreenshot")
      );
      expect(
        order.at(-1) === UNMASK_SCRIPT || order.includes(UNMASK_SCRIPT)
      ).toBe(true);
    });

    it("covers an out-of-process frame the page's own tree does not list", async () => {
      const { relay, source } = setup();
      await source.materialize("s1", "https://shop.test/pay");
      Object.assign(relay, {
        childFrames: () => ["oopif"],
        frameOrigin: (_tabId: number, frameId: string) =>
          frameId === "oopif" ? "https://pay.test" : null,
      });
      const { sent } = secretPage(relay, {
        "Page.getFrameTree": () => ({
          frameTree: {
            frame: { id: "main", securityOrigin: "https://shop.test" },
          },
        }),
      });

      expect(
        await source.captureMasked(100, source.secrets(100)!)
      ).not.toBeNull();
      expect(
        sent
          .filter((call) => call.method === "DOM.getFrameOwner")
          .map((call) => call.params.frameId)
      ).toEqual(["oopif"]);
    });

    it("takes no screenshot when a cross-origin frame cannot be covered or the fields cannot be hidden", async () => {
      for (const overrides of [
        // The frame's owner cannot be found,
        { "DOM.getFrameOwner": () => Promise.reject(new Error("gone")) },
        // or the mask did not cover it,
        {
          "Runtime.evaluate": (params: Record<string, unknown>) =>
            params.expression === FIND_SECRET_FIELDS_SCRIPT
              ? { result: { objectId: "found" } }
              : {
                  result: {
                    value:
                      params.expression === "location.origin"
                        ? "https://shop.test"
                        : params.expression === MASK_FOR_CAPTURE_SCRIPT
                          ? 0
                          : true,
                  },
                },
        },
        // or the frames are unknown,
        { "Page.getFrameTree": () => Promise.reject(new Error("no tree")) },
        // or the page cannot be searched for its fields.
        {
          "Runtime.evaluate": () => ({ exceptionDetails: { text: "blocked" } }),
        },
      ]) {
        const { relay, source } = setup();
        await source.materialize("s1", "https://shop.test/pay");
        const { sent } = secretPage(relay, overrides);

        expect(
          await source.captureMasked(100, source.secrets(100)!)
        ).toBeNull();
        expect(sent.map((call) => call.method)).not.toContain(
          "Page.captureScreenshot"
        );
      }
    });
  });
  it("has nothing to make when Chrome is not connected", async () => {
    const { relay, source } = setup();
    relay.connected = false;
    expect(await source.materialize("s1", "https://x.test/")).toBeNull();
  });
});

describe("the hosted computer's own Chromium", () => {
  /** A Chromium on the CDP pipe: answers what the driver asks, raises what a tab does. */
  const fakeChromium = () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, toBrowser, fromBrowser],
      kill: vi.fn(),
    });
    const sent: Array<{ method: string; sessionId?: string }> = [];
    const raise = (message: Record<string, unknown>) =>
      fromBrowser.write(`${JSON.stringify(message)}\0`);
    /** What the browser raises before it answers a command, by method. */
    const before: Record<string, (targetId: string) => void> = {};
    let created = 0;
    let buffer = "";
    toBrowser.setEncoding("utf8");
    toBrowser.on("data", (chunk: string) => {
      buffer += chunk;
      for (
        let end = buffer.indexOf("\0");
        end !== -1;
        end = buffer.indexOf("\0")
      ) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        sent.push(message);
        const made = `T${created + 1}`;
        if (message.method === "Target.createTarget") {
          created += 1;
          before[message.method]?.(made);
        }
        const result =
          message.method === "Target.createTarget"
            ? { targetId: made }
            : message.method === "Target.attachToTarget"
              ? {
                  sessionId: String(message.params.targetId).replace(/^T/, "S"),
                }
              : {};
        raise({ id: message.id, result });
      }
    });
    return {
      child,
      sent,
      raise,
      before,
      spawn: vi.fn((_command: string, _args: string[]) => child),
    };
  };

  it("launches headless, gives each session a tab, and drops it when it closes", async () => {
    const { CdpBrowser, hostedChromiumArgs } =
      await import("./hosted-chromium");
    const chromium = fakeChromium();
    const args = hostedChromiumArgs("/p", true);
    const browser = new CdpBrowser({
      executable: "/opt/chromium/chrome",
      args,
      spawn: chromium.spawn as never,
    });
    const source = new ChromeTargetSource(browser);
    await browser.launch();

    expect(chromium.spawn.mock.calls[0]?.[1]).toEqual(args);
    expect(args).toEqual(
      expect.arrayContaining(["--headless=new", "--user-data-dir=/p"])
    );
    const id = await source.materialize("session-1", "https://example.test/");
    expect(id).not.toBeNull();
    expect(source.candidates()).toEqual([
      expect.objectContaining({ id, sessionId: "session-1" }),
    ]);
    // Commands for the tab go on its session; its events come back as the tab's.
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({ method: "Page.enable", sessionId: "S1" })
    );
    const page = source.webContents(id!)!;
    chromium.raise({
      method: "Page.frameNavigated",
      sessionId: "S1",
      params: { frame: { id: "F", url: "https://example.test/next" } },
    });
    await vi.waitFor(() =>
      expect(page.getURL()).toBe("https://example.test/next")
    );

    chromium.raise({
      method: "Target.targetDestroyed",
      params: { targetId: "T1" },
    });
    await vi.waitFor(() => expect(source.candidates()).toEqual([]));
    expect(page.isDestroyed()).toBe(true);

    chromium.child.emit("exit", 0);
    expect(browser.connected).toBe(false);
  });

  const launched = async () => {
    const { CdpBrowser } = await import("./hosted-chromium");
    const chromium = fakeChromium();
    const browser = new CdpBrowser({
      executable: "/opt/chromium/chrome",
      args: [],
      spawn: chromium.spawn as never,
    });
    const source = new ChromeTargetSource(browser);
    await browser.launch();
    const id = (await source.materialize(
      "session-1",
      "https://flights.test/"
    ))!;
    return { chromium, browser, source, id };
  };

  it("drives the tab a page opens, brought to the front, and its opener again once it closes", async () => {
    const { chromium, source, id } = await launched();
    // Each tab's cross-origin frames are attached on its own session.
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.setAutoAttach",
        sessionId: "S1",
        params: expect.objectContaining({ autoAttach: true, flatten: true }),
      })
    );

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "POP",
          type: "page",
          url: "https://airline.test/book",
          openerId: "T1",
        },
      },
    });

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toEqual([
        expect.objectContaining({ id, current: false }),
        expect.objectContaining({ current: true, openerId: id }),
      ])
    );
    const popup = source.sessionTabs("session-1")[1]!.id;
    expect(
      pickBrowserTarget(source.candidates(), { id, url: null }, "session-1")
    ).toBe(popup);
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.activateTarget",
        params: { targetId: "POP" },
      })
    );

    chromium.raise({
      method: "Target.targetDestroyed",
      params: { targetId: "POP" },
    });
    await vi.waitFor(() =>
      expect(
        pickBrowserTarget(
          source.candidates(),
          { id: popup, url: null },
          "session-1"
        )
      ).toBe(id)
    );
  });

  it("attaches an opener-less page and gives it to the session that just clicked", async () => {
    const { chromium, source } = await launched();
    source.noteAction("session-1");

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: { targetId: "NOOPENER", type: "page", url: "" },
      },
    });

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toHaveLength(2)
    );
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Target.attachToTarget",
        params: expect.objectContaining({ targetId: "NOOPENER" }),
      })
    );
  });

  it("gives a noopener page to the tab whose frame the browser names as its opener, click or no click", async () => {
    const { chromium, source, id } = await launched();

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "NOOPENER",
          type: "page",
          url: "https://airline.test/",
          openerFrameId: "T1",
        },
      },
    });

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toEqual([
        expect.objectContaining({ id, current: false }),
        expect.objectContaining({ current: true, openerId: id }),
      ])
    );
  });

  it("leaves a page whose named opener is not one of its tabs unowned, even right after a click", async () => {
    const { chromium, source } = await launched();
    source.noteAction("session-1");

    chromium.raise({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: "ELSEWHERE",
          type: "page",
          url: "https://x.test/",
          openerId: "NOT-OURS",
        },
      },
    });

    await vi.waitFor(() =>
      expect(chromium.sent).toContainEqual(
        expect.objectContaining({
          method: "Target.attachToTarget",
          params: expect.objectContaining({ targetId: "ELSEWHERE" }),
        })
      )
    );
    await vi.waitFor(() => expect(source.candidates()).toHaveLength(2));
    expect(source.sessionTabs("session-1")).toHaveLength(1);
  });

  it("attaches a page it makes once, for its session, while another session's popup still joins", async () => {
    const { chromium, source, id } = await launched();
    // The browser reports the made page (no opener) and a popup of session-1's
    // tab before it answers the create.
    chromium.before["Target.createTarget"] = (made) => {
      chromium.raise({
        method: "Target.targetCreated",
        params: { targetInfo: { targetId: made, type: "page", url: "" } },
      });
      chromium.raise({
        method: "Target.targetCreated",
        params: {
          targetInfo: {
            targetId: "POP",
            type: "page",
            url: "https://airline.test/",
            openerId: "T1",
          },
        },
      });
    };

    const made = await source.materialize("session-2", "https://b.test/");

    await vi.waitFor(() =>
      expect(source.sessionTabs("session-1")).toEqual([
        expect.objectContaining({ id }),
        expect.objectContaining({ current: true, openerId: id }),
      ])
    );
    expect(source.sessionTabs("session-2").map((tab) => tab.id)).toEqual([
      made,
    ]);
    expect(
      chromium.sent.filter(
        (message) =>
          message.method === "Target.attachToTarget" &&
          (message as { params?: { targetId?: string } }).params?.targetId ===
            "T2"
      )
    ).toHaveLength(1);
  });

  it("knows a cross-origin frame's live origin from its own attach", async () => {
    const { chromium, source, id } = await launched();

    chromium.raise({
      method: "Target.attachedToTarget",
      sessionId: "S1",
      params: {
        sessionId: "FRAME-SESSION",
        targetInfo: {
          targetId: "CARD",
          type: "iframe",
          url: "https://pay.test/card",
        },
      },
    });
    await vi.waitFor(async () =>
      expect(await source.tabs.origin(id, "CARD")).toBe("https://pay.test")
    );

    chromium.raise({
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: "CARD",
          type: "iframe",
          url: "https://other-pay.test/card",
        },
      },
    });
    await vi.waitFor(async () =>
      expect(await source.tabs.origin(id, "CARD")).toBe(
        "https://other-pay.test"
      )
    );
  });

  it("fails closed on a frame's live origin when the frame does not answer, whatever it remembers", async () => {
    const { chromium, source, id } = await launched();

    chromium.raise({
      method: "Target.attachedToTarget",
      sessionId: "S1",
      params: {
        sessionId: "FRAME-SESSION",
        targetInfo: {
          targetId: "CARD",
          type: "iframe",
          url: "https://pay.test/card",
        },
      },
    });
    await vi.waitFor(async () =>
      expect(await source.tabs.origin(id, "CARD")).toBe("https://pay.test")
    );

    // This Chromium answers no evaluation: the remembered origin is no answer.
    expect(await source.tabs.liveOrigin(id, "CARD")).toBeNull();
    expect(chromium.sent).toContainEqual(
      expect.objectContaining({
        method: "Runtime.evaluate",
        sessionId: "FRAME-SESSION",
      })
    );
    expect(await source.tabs.liveOrigin(id, "NOT-ATTACHED")).toBeNull();
    expect(await source.tabs.liveOrigin(id)).toBeNull();
  });

  it("turns off saved passwords and autofill in the profile, keeping its other preferences", async () => {
    const { writeHostedChromiumPrefs } = await import("./hosted-chromium");
    const profile = mkdtempSync(path.join(os.tmpdir(), "hosted-profile-"));
    mkdirSync(path.join(profile, "Default"));
    writeFileSync(
      path.join(profile, "Default/Preferences"),
      JSON.stringify({ homepage: "x", profile: { name: "Me" } })
    );

    writeHostedChromiumPrefs(profile);

    const prefs = JSON.parse(
      readFileSync(path.join(profile, "Default/Preferences"), "utf8")
    );
    expect(prefs).toMatchObject({
      homepage: "x",
      credentials_enable_service: false,
      profile: { name: "Me", password_manager_enabled: false },
      autofill: {
        enabled: false,
        profile_enabled: false,
        credit_card_enabled: false,
      },
    });
    rmSync(profile, { recursive: true, force: true });
  });

  it("finds Playwright's Chromium in its cache, the full browser ahead of the shell", async () => {
    const { chromiumInCache } = await import("./hosted-chromium");
    const root = mkdtempSync(path.join(os.tmpdir(), "ms-playwright-"));
    const touch = (relative: string) => {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), "");
    };
    expect(chromiumInCache([root])).toBeNull();
    touch(
      "chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell"
    );
    expect(chromiumInCache([root])).toContain("chrome-headless-shell");
    touch("chromium-1200/chrome-linux64/chrome");
    touch("chromium-1243/chrome-linux64/chrome");
    expect(chromiumInCache([root])).toBe(
      path.join(root, "chromium-1243/chrome-linux64/chrome")
    );
  });

  describe("the launcher", () => {
    const profile = () => mkdtempSync(path.join(os.tmpdir(), "chromium-"));
    const launcherWith = async (
      options: Partial<
        ConstructorParameters<
          typeof import("./hosted-chromium").HostedChromiumLauncher
        >[0]
      > = {}
    ) => {
      const { HostedChromiumLauncher } = await import("./hosted-chromium");
      const chromium = fakeChromium();
      const lines: string[] = [];
      const launcher = new HostedChromiumLauncher({
        userDataDir: profile,
        hosted: () => false,
        isRoot: () => false,
        env: {},
        find: async () => "/found/chrome",
        spawn: chromium.spawn as never,
        log: (line) => lines.push(line),
        ...options,
      });
      return { launcher, chromium, lines };
    };

    it("takes the path from ABACUSAI_BOT_CHROMIUM at once, with no lookup, and says so", async () => {
      const executable = path.join(profile(), "chrome");
      writeFileSync(executable, "");
      const find = vi.fn(async () => "/found/chrome");
      const { launcher, chromium, lines } = await launcherWith({
        env: { ABACUSAI_BOT_CHROMIUM: executable },
        find,
      });

      expect(launcher.found).toBe(true);
      expect((await launcher.launch()).ok).toBe(true);
      expect(await launcher.prepare()).toBe(true);
      expect(chromium.spawn.mock.calls[0]?.[0]).toBe(executable);
      expect(find).not.toHaveBeenCalled();
      expect(lines).toContain(
        `[browser] Chromium from ABACUSAI_BOT_CHROMIUM: ${executable}`
      );
    });

    it("looks up once at start, then in the background with backoff; launch never looks", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const find = vi
          .fn<() => Promise<string | null>>()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValue("/found/chrome");
        const { launcher, chromium } = await launcherWith({ find });

        expect(await launcher.prepare()).toBe(false);
        const missed = await launcher.launch();
        expect("error" in missed && missed.error.code).toBe("not-found");
        expect(find).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(find).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(59_999);
        expect(find).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(find).toHaveBeenCalledTimes(3);
        expect(launcher.found).toBe(true);

        expect((await launcher.launch()).ok).toBe(true);
        expect(chromium.spawn.mock.calls[0]?.[0]).toBe("/found/chrome");
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(find).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops looking once disposed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const find = vi.fn(async () => null);
        const { launcher } = await launcherWith({ find });
        await launcher.prepare();
        launcher.dispose();
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(find).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the sandbox only as root or on the hosted computer", async () => {
      for (const [isRoot, hosted, noSandbox] of [
        [false, false, false],
        [true, false, true],
        [false, true, true],
      ] as const) {
        const { launcher, chromium } = await launcherWith({
          isRoot: () => isRoot,
          hosted: () => hosted,
        });
        await launcher.prepare();
        await launcher.launch();
        expect(chromium.spawn.mock.calls[0]?.[1].includes("--no-sandbox")).toBe(
          noSandbox
        );
      }
    });

    describe("the profile lock", () => {
      /** The lock is a dangling symlink, so `existsSync` cannot see it. */
      const locked = (lock: string) => {
        try {
          lstatSync(lock);
          return true;
        } catch {
          return false;
        }
      };
      /** A profile whose SingletonLock names this host and a pid that is alive. */
      const lockedProfile = () => {
        const dir = profile();
        const lock = path.join(dir, "SingletonLock");
        symlinkSync(`${os.hostname()}-${process.pid}`, lock);
        return { dir, lock };
      };
      const launchOn = async (
        dir: string,
        options: Parameters<typeof launcherWith>[0] = {}
      ) => {
        const delay = vi.fn(async () => {});
        const made = await launcherWith({
          userDataDir: () => dir,
          delay,
          ...options,
        });
        await made.launcher.prepare();
        return { ...made, delay, launched: await made.launcher.launch() };
      };

      it("blocks on a live Chromium on this profile, after one retry", async () => {
        const { dir, lock } = lockedProfile();
        const readCmdline = vi.fn(() => [
          "/opt/chromium/chrome",
          "--headless=new",
          `--user-data-dir=${dir}`,
        ]);

        const { launched, chromium, delay } = await launchOn(dir, {
          readCmdline,
        });

        expect("error" in launched && launched.error.code).toBe(
          "profile-in-use"
        );
        expect(delay).toHaveBeenCalledOnce();
        expect(delay).toHaveBeenCalledWith(2_000);
        expect(readCmdline).toHaveBeenCalledTimes(2);
        expect(chromium.spawn).not.toHaveBeenCalled();
        expect(locked(lock)).toBe(true);
      });

      it("launches when the retry finds the profile free", async () => {
        const { dir, lock } = lockedProfile();
        const delay = vi.fn(async () => rmSync(lock));
        const { launched } = await launchOn(dir, {
          readCmdline: () => ["/opt/chromium/chrome", `--user-data-dir=${dir}`],
          delay,
        });
        expect(launched.ok).toBe(true);
        expect(delay).toHaveBeenCalledOnce();
      });

      it("clears a recycled pid's lock: alive, but not a Chromium on this profile", async () => {
        for (const argv of [
          ["/usr/bin/node", "server.js"],
          ["/opt/chromium/chrome", "--user-data-dir=/elsewhere"],
        ]) {
          const { dir, lock } = lockedProfile();
          const { launched, delay } = await launchOn(dir, {
            readCmdline: () => argv,
          });
          expect(launched.ok).toBe(true);
          expect(delay).not.toHaveBeenCalled();
          expect(locked(lock)).toBe(false);
        }
      });

      it("clears a dead owner's lock", async () => {
        const dir = profile();
        const lock = path.join(dir, "SingletonLock");
        symlinkSync(`${os.hostname()}-999999999`, lock);
        const { launched } = await launchOn(dir);
        expect(launched.ok).toBe(true);
        expect(locked(lock)).toBe(false);
      });

      it("without /proc, holds to a lock made since this process started and clears an older one", async () => {
        const { dir, lock } = lockedProfile();
        const held = await launchOn(dir, {
          readCmdline: () => undefined,
          processStart: () => Date.now() - 60_000,
        });
        expect("error" in held.launched && held.launched.error.code).toBe(
          "profile-in-use"
        );
        expect(locked(lock)).toBe(true);

        const stale = await launchOn(dir, {
          readCmdline: () => undefined,
          processStart: () => Date.now() + 60_000,
        });
        expect(stale.launched.ok).toBe(true);
        expect(locked(lock)).toBe(false);
      });
    });

    it("reports a failed launch as its typed error, the raw cause only in the log", async () => {
      const { HostedChromiumLaunchError, HostedChromiumService } =
        await import("./hosted-chromium");
      const { launcher, chromium, lines } = await launcherWith();
      chromium.spawn.mockImplementation(() => {
        throw new Error("spawn /found/chrome EACCES secret-detail");
      });
      const service = new HostedChromiumService(launcher);
      await service.prepare();

      const failure = await service
        .targetSource()
        .materialize("s1", "https://x.test/")
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(HostedChromiumLaunchError);
      expect(
        (failure as InstanceType<typeof HostedChromiumLaunchError>).code
      ).toBe("launch-failed");
      expect((failure as Error).message).not.toContain("secret-detail");
      expect(lines.some((line) => line.includes("secret-detail"))).toBe(true);
    });
  });

  it("sends an isolated context through the watch proxy, loopback too, and closes it with the context", async () => {
    const { CdpBrowser } = await import("./hosted-chromium");
    const chromium = fakeChromium();
    const closed = vi.fn(async () => {});
    const watchProxy = vi.fn(async (_options: { port: number }) => ({
      server: "http://127.0.0.1:4100",
      close: closed,
    }));
    const browser = new CdpBrowser({
      executable: "/opt/chromium/chrome",
      args: [],
      spawn: chromium.spawn as never,
      watchProxy: watchProxy as never,
    });
    await browser.launch();
    const { dispose } = await browser.createIsolatedTab("about:blank", {
      port: 8443,
    });
    expect(watchProxy).toHaveBeenCalledWith({ port: 8443 });
    const created = chromium.sent.find(
      (message) => message.method === "Target.createBrowserContext"
    ) as { params?: Record<string, unknown> } | undefined;
    expect(created?.params).toEqual({
      proxyServer: "http://127.0.0.1:4100",
      proxyBypassList: "<-loopback>",
    });
    expect(closed).not.toHaveBeenCalled();
    await dispose();
    expect(closed).toHaveBeenCalledTimes(1);
    // No port named: the https default.
    await browser.createIsolatedTab("about:blank");
    expect(watchProxy).toHaveBeenLastCalledWith({ port: 443 });
  });
});

describe("an isolated session's pages", () => {
  const isolatedSetup = () => {
    const { relay, source, clock } = setup();
    const disposed = vi.fn(async () => {});
    (relay as unknown as Record<string, unknown>).createIsolatedTab = async (
      url: string
    ) => {
      const tab = { id: relay.next++, url, browserContextId: "ctx-1" };
      relay.tabs.set(tab.id, tab);
      relay.attached.add(tab.id);
      relay.emit("tabAttached", tab);
      return { tab, browserContextId: "ctx-1", dispose: disposed };
    };
    return { relay, source, clock, disposed };
  };

  it("opens in a context of its own, and takes its own popups", async () => {
    const { relay, source } = isolatedSetup();
    const id = await source.materialize("watch", "https://shop.example/", {
      isolated: true,
    });
    expect(relay.tab(id!)?.browserContextId).toBe("ctx-1");
    const popup = { id: 900, url: "about:blank", browserContextId: "ctx-1" };
    relay.tabs.set(popup.id, popup);
    relay.attached.add(popup.id);
    relay.emit("tabAttached", popup);
    expect(
      source.candidates().find((candidate) => candidate.id === 900)?.sessionId
    ).toBe("watch");
  });

  it("never lends one of its pages to another session, nor takes a profile page", async () => {
    const { relay, source } = isolatedSetup();
    await source.materialize("watch", "https://shop.example/", {
      isolated: true,
    });
    await source.materialize("user", "https://mail.example/");
    // Both acted; an opener-less page in the isolated context is the isolated one's.
    source.noteAction("user");
    source.noteAction("watch");
    const fromIsolated = {
      id: 901,
      url: "https://x.example/",
      browserContextId: "ctx-1",
    };
    relay.tabs.set(fromIsolated.id, fromIsolated);
    relay.attached.add(fromIsolated.id);
    relay.emit("tabAttached", fromIsolated);
    expect(
      source.candidates().find((candidate) => candidate.id === 901)?.sessionId
    ).toBe("watch");
    // A profile page is never the isolated session's, however recently it acted.
    source.noteAction("watch");
    const fromProfile = { id: 902, url: "https://y.example/" };
    relay.tabs.set(fromProfile.id, fromProfile);
    relay.attached.add(fromProfile.id);
    relay.emit("tabAttached", fromProfile);
    expect(
      source.candidates().find((candidate) => candidate.id === 902)?.sessionId
    ).not.toBe("watch");
  });

  it("goes, context and pages, when the session ends", async () => {
    const { relay, source, disposed } = isolatedSetup();
    const id = await source.materialize("watch", "https://shop.example/", {
      isolated: true,
    });
    source.releaseSession("watch");
    await Promise.resolve();
    expect(relay.closeTab).toHaveBeenCalledWith(id);
    expect(disposed).toHaveBeenCalled();
  });

  it("is refused outright where the browser cannot isolate it", async () => {
    const { source } = setup();
    await expect(
      source.materialize("watch", "https://shop.example/", { isolated: true })
    ).rejects.toThrow(/apart from its profile/);
  });
});
