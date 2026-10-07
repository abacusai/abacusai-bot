import { afterEach, describe, expect, it, vi } from "vitest";

import { NotchDirector, type DirectorDeps } from "./director";
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
  audio: () => false,
  commit: vi.fn(),
});
afterEach(() => vi.useRealTimers());
describe("R6-T17 / T19 / T42 presentation generations", () => {
  it("reports visibility once before navigation without a native animation handshake", async () => {
    const d = deps();
    const calls: string[] = [];
    d.setShape = vi.fn(async (s) => {
      calls.push(s.phase);
      expect(s.width).toBe(200);
    });
    d.navigate = async () => {
      calls.push("navigate");
    };
    const director = new NotchDirector(d);
    await director.present(p("a"), { width: 200, height: 200 });
    expect(calls).toEqual(["final", "navigate"]);
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
});

it("immediate calm clears old queued attention before unlocking", async () => {
  const d = deps();
  const director = new NotchDirector(d);
  await director.present(p("a"), { width: 200, height: 200 });
  director.lock(true);
  const b = p("b");
  b.queue.push(p("a").attention!);
  await director.present(b, { width: 200, height: 200 });
  await director.present(
    { ...p("a"), route: "/idle", identity: "calm", expanded: false },
    { width: 200, height: 32 }
  );
  director.lock(false);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(d.navigate).toHaveBeenLastCalledWith(
    expect.objectContaining({ identity: "calm" })
  );
  director.dispose();
});
it.each(["load", "navigate", "final"])(
  "the total deadline bounds stalled %s and retires both threads",
  async (stage) => {
    vi.useFakeTimers();
    const d = deps();
    const never = () => new Promise<void>(() => {});
    if (stage === "load") d.load = vi.fn(never);
    if (stage === "navigate") d.navigate = vi.fn(never);
    if (stage === "final")
      d.setShape = vi.fn((s) =>
        s.phase === stage ? never() : Promise.resolve()
      );
    const director = new NotchDirector(d);
    const item = p("a");
    item.queue.push(p("b").attention!);
    let done = false;
    const pending = director
      .present(item, { width: 200, height: 200 })
      .then(() => {
        done = true;
      });
    await vi.advanceTimersByTimeAsync(8000);
    expect(done).toBe(true);
    await pending;
    expect(d.retire).toHaveBeenCalledWith("a");
    expect(d.retire).toHaveBeenCalledWith("b");
    expect(d.commit).toHaveBeenLastCalledWith(
      expect.objectContaining({ expanded: false }),
      { width: 200, height: 32 }
    );
    director.dispose();
  }
);

it("unlock revalidates the proposed attention against the latest queue", async () => {
  const d = deps();
  const director = new NotchDirector(d);
  await director.present(p("a"), { width: 200, height: 200 });
  director.lock(true);
  await director.present(
    { ...p("b"), queue: p("a").queue },
    { width: 200, height: 200 }
  );
  director.lock(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(d.navigate).toHaveBeenCalledTimes(1);
  director.dispose();
});

it("does not shorten a collapsed camera exclusion at a larger display scale", async () => {
  const d = deps();
  const director = new NotchDirector(d);
  await director.present(
    { ...p("a"), expanded: false },
    { width: 340, height: 44, compactHeight: 44 }
  );
  expect(d.commit).toHaveBeenLastCalledWith(
    expect.objectContaining({ expanded: false }),
    expect.objectContaining({ height: 44 })
  );
  expect(d.setShape).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "final", height: 44 }),
    expect.any(AbortSignal)
  );
  director.dispose();
});
