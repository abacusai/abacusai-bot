import { afterEach, beforeEach, expect, it, vi } from "vitest";
const add = vi.hoisted(() => vi.fn());
vi.mock("#renderer/ui/toast", () => ({ toast: { add } }));
beforeEach(() => {
  add.mockClear();
  localStorage.clear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("elects one tab and deduplicates notifications from multiple tabs", async () => {
  vi.useFakeTimers();
  const peers: Channel[] = [];
  class Channel {
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      peers.push(this);
    }
    postMessage(data: unknown) {
      for (const peer of peers) if (peer !== this) peer.onmessage?.({ data });
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  const notify = vi.fn();
  vi.stubGlobal(
    "Notification",
    class {
      static permission = "granted";
      constructor(...args: unknown[]) {
        notify(...args);
      }
    }
  );
  const first = await import("./notifications");
  vi.resetModules();
  const second = await import("./notifications");
  const notice = { title: "Done", body: "Result", dedupeKey: "turn" };
  const pending = [first.browserNotify(notice), second.browserNotify(notice)];
  await vi.advanceTimersByTimeAsync(250);
  await Promise.all(pending);
  expect(notify).toHaveBeenCalledOnce();
  expect(add).not.toHaveBeenCalled();
});
it("falls back to a toast when permission is unavailable", async () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("Notification", undefined);
  const { browserNotify } = await import("./notifications");
  await browserNotify({ title: "Done", body: "Result" });
  expect(add).toHaveBeenCalledWith({ title: "Done", description: "Result" });
});

it("rediscoveries after heartbeat gaps avoid duplicates and a departed leader is replaced", async () => {
  vi.useFakeTimers();
  localStorage.clear();
  const peers: Channel[] = [];
  class Channel {
    onmessage?: (event: { data: unknown }) => void;
    constructor() {
      peers.push(this);
    }
    postMessage(data: unknown) {
      for (const peer of peers) if (peer !== this) peer.onmessage?.({ data });
    }
  }
  vi.stubGlobal("BroadcastChannel", Channel);
  vi.stubGlobal("Notification", undefined);
  const first = await import("./notifications");
  first.installBrowserAttention();
  vi.resetModules();
  const second = await import("./notifications");
  second.installBrowserAttention();
  const notify = async (key: string) => {
    const pending = [
      first.browserNotify({ title: "Done", body: "Result", dedupeKey: key }),
      second.browserNotify({ title: "Done", body: "Result", dedupeKey: key }),
    ];
    await vi.advanceTimersByTimeAsync(250);
    await Promise.all(pending);
  };
  await notify("initial");
  expect(add).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(10_000);
  await notify("after-gap");
  expect(add).toHaveBeenCalledTimes(2);
  // Leave just the second instance; whichever id led, it must deliver now.
  peers.shift();
  await vi.advanceTimersByTimeAsync(10_000);
  const pending = second.browserNotify({
    title: "Done",
    body: "Result",
    dedupeKey: "after-departure",
  });
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(add).toHaveBeenCalledTimes(3);
});
