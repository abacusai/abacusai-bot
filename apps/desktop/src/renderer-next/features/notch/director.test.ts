import { afterEach, describe, expect, it, vi } from "vitest";

import { NotchDirector, shapeSettled, type DirectorDeps } from "./director";
import type { NotchPresentation } from "./presenter";
const p = (id: string): NotchPresentation => ({
  route: "/approval/$id",
  sessionId: id,
  identity: id,
  faces: [],
  remaining: 0,
  expanded: true,
  hidden: false,
  quietUntil: null,
  attention: {
    kind: "approval",
    sessionId: id,
    since: 0,
    botId: null,
    descriptorId: id,
  },
  queue: [
    {
      kind: "approval",
      sessionId: id,
      since: 0,
      botId: null,
      descriptorId: id,
    },
  ],
});
const deps = (): DirectorDeps => ({
  load: vi.fn(async () => {}),
  retire: vi.fn(),
  setShape: vi.fn(async () => {}),
  navigate: vi.fn(async () => {}),
  settle: vi.fn(async () => {}),
  renderedSize: () => ({ width: 300, height: 40 }),
  audio: () => false,
  commit: vi.fn(),
});
afterEach(() => vi.useRealTimers());
describe("R6-T17 / T19 / T42 presentation generations", () => {
  it("envelopes mixed dimensions before navigation, final after settling", async () => {
    const d = deps();
    const calls: string[] = [];
    d.setShape = vi.fn(async (s) => {
      calls.push(s.phase);
      expect(s.width).toBe(s.phase === "envelope" ? 300 : 200);
    });
    d.navigate = async () => {
      calls.push("navigate");
    };
    d.settle = async () => {
      calls.push("settle");
    };
    const director = new NotchDirector(d);
    await director.present(p("a"), { width: 200, height: 200 });
    expect(calls).toEqual(["envelope", "navigate", "settle", "final"]);
    director.dispose();
  });
  it("out-of-order hydration cannot navigate the previous identity", async () => {
    let resolve!: () => void;
    const d = deps();
    d.load = vi.fn((id) =>
      id === "a"
        ? new Promise<void>((r) => {
            resolve = r;
          })
        : Promise.resolve()
    );
    const director = new NotchDirector(d);
    const old = director.present(p("a"), { width: 200, height: 200 });
    await director.present(p("b"), { width: 200, height: 200 });
    resolve();
    await old;
    expect(d.navigate).toHaveBeenCalledExactlyOnceWith(p("b"));
    director.dispose();
  });
  it("8 second deadline becomes a compact actionable wing", async () => {
    vi.useFakeTimers();
    const d = deps();
    d.load = vi.fn(
      (_id, signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        )
    );
    const director = new NotchDirector(d);
    const pending = director.present(p("a"), { width: 200, height: 200 });
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(d.commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ expanded: false }),
      { width: 200, height: 32 }
    );
    expect(d.retire).toHaveBeenCalledWith("a");
    director.dispose();
  });
  it("retirement bounds twenty sequential presentations to two held sessions", async () => {
    const held = new Set<string>();
    let max = 0;
    const d = deps();
    d.load = async (id) => {
      held.add(id);
      max = Math.max(max, held.size);
    };
    d.retire = (id) => {
      held.delete(id);
    };
    const director = new NotchDirector(d);
    for (let i = 0; i < 20; i++) {
      const item = p(String(i));
      item.queue.push(p(String(i + 1)).attention!);
      await director.present(item, { width: 200, height: 200 });
    }
    expect(max).toBeLessThanOrEqual(2);
    director.dispose();
    expect(held.size).toBe(0);
  });
  it("hover lock queues valid attention but calm applies immediately", async () => {
    const d = deps();
    const director = new NotchDirector(d);
    await director.present(p("a"), { width: 200, height: 200 });
    director.lock(true);
    const next = p("b");
    next.queue.push(p("a").attention!);
    await director.present(next, { width: 200, height: 200 });
    expect(d.navigate).toHaveBeenCalledTimes(1);
    await director.present(
      { ...next, route: "/idle", identity: "calm", expanded: false },
      { width: 200, height: 40 }
    );
    expect(d.navigate).toHaveBeenCalledTimes(2);
    director.dispose();
  });
  it("unchanged and reduced sizes settle without events", async () => {
    const node = document.createElement("div");
    await shapeSettled(
      node,
      { width: 1, height: 2 },
      { width: 1, height: 2 },
      false,
      new AbortController().signal
    );
    await shapeSettled(
      node,
      { width: 1, height: 2 },
      { width: 3, height: 4 },
      true,
      new AbortController().signal
    );
  });
  it("both axes settle, transitioncancel and missing events have bounded fallbacks", async () => {
    vi.useFakeTimers();
    const node = document.createElement("div");
    let done = false;
    const pending = shapeSettled(
      node,
      { width: 1, height: 2 },
      { width: 3, height: 4 },
      false,
      new AbortController().signal
    ).then(() => {
      done = true;
    });
    node.dispatchEvent(new Event("transitioncancel"));
    await pending;
    expect(done).toBe(true);
    const fallback = shapeSettled(
      node,
      { width: 1, height: 2 },
      { width: 3, height: 4 },
      false,
      new AbortController().signal
    );
    await vi.advanceTimersByTimeAsync(450);
    await fallback;
  });
});
