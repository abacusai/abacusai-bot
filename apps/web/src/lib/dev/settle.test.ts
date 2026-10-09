/** R1-T21: navigateAndSettle waits for the right things and freezes loops. */
import { describe, expect, it } from "vitest";

import { navigateAndSettle } from "./settle";

const animation = (endTime: number, durationMs = 0) => {
  let resolve!: () => void;
  const finished = new Promise<void>((r) => (resolve = r));
  const a = {
    effect: { getComputedTiming: () => ({ endTime }) },
    playState: "running" as AnimationPlayState,
    finished,
    currentTime: 123 as number | null,
    paused: false,
    pause() {
      a.paused = true;
    },
  };
  if (endTime !== Infinity)
    setTimeout(() => {
      a.playState = "finished";
      resolve();
    }, durationMs);
  return a;
};

const fakeRouter = () => {
  const listeners = new Set<
    (event: { toLocation: { href: string } }) => void
  >();
  const state = { location: { href: "/bots/new" }, status: "idle" };
  return {
    state,
    navigated: [] as string[],
    subscribe: (
      _event: string,
      listener: (event: { toLocation: { href: string } }) => void
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    navigate(options: { href: string }) {
      this.navigated.push(options.href);
      return Promise.resolve();
    },
    resolve(href: string) {
      state.location.href = href;
      for (const listener of Array.from(listeners))
        listener({ toLocation: { href } });
    },
  };
};

const frame = (callback: () => void) => void setTimeout(callback, 1);

describe("navigateAndSettle", () => {
  it("resolves with an infinite animation running, frozen at 0", async () => {
    const spin = animation(Infinity);
    const doc = {
      getAnimations: () => [spin],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame,
    });
    router.resolve("/sessions/new");
    await done;
    expect(spin.paused).toBe(true);
    expect(spin.currentTime).toBe(0);
  });

  it("waits for a finite 200 ms animation", async () => {
    const fade = animation(200, 200);
    const doc = {
      getAnimations: () => [fade],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const started = Date.now();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame,
    });
    router.resolve("/sessions/new");
    await done;
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(fade.playState).toBe("finished");
  });

  it("settles a finished animation whose completion promise stays pending", async () => {
    const fade = animation(Infinity);
    fade.effect.getComputedTiming = () => ({ endTime: 150 });
    const doc = {
      getAnimations: () => [fade],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame,
    });
    router.resolve("/sessions/new");
    setTimeout(() => {
      fade.playState = "finished";
    }, 20);
    await done;
    expect(fade.paused).toBe(false);
    expect(fade.playState).toBe("finished");
  }, 1_000);

  it("rejects a finite animation that remains running", async () => {
    const fade = animation(Infinity);
    fade.effect.getComputedTiming = () => ({ endTime: 150 });
    const doc = {
      getAnimations: () => [fade],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame,
      timeoutMs: 30,
    });
    router.resolve("/sessions/new");
    await expect(done).rejects.toThrow("finite animations did not settle");
    expect(fade.playState).toBe("running");
    expect(fade.paused).toBe(false);
  });

  it("does not resolve on a previous route's onResolved", async () => {
    const doc = {
      getAnimations: () => [],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    let settled = false;
    const done = navigateAndSettle("/routines", {
      router: router as never,
      doc,
      frame,
      timeoutMs: 1_000,
    }).then(() => {
      settled = true;
    });
    router.resolve("/bots/new");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    router.resolve("/routines");
    await done;
    expect(settled).toBe(true);
  });

  it("waits for loading collections", async () => {
    const doc = {
      getAnimations: () => [],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const listeners: Array<() => void> = [];
    const collection = {
      status: "loading",
      on: (_: string, cb: () => void) => {
        listeners.push(cb);
        return () => undefined;
      },
    };
    let settled = false;
    const done = navigateAndSettle("/routines", {
      router: router as never,
      doc,
      frame,
      collections: [collection],
    }).then(() => {
      settled = true;
    });
    router.resolve("/routines");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    collection.status = "ready";
    for (const listener of listeners) listener();
    await done;
  });

  it("neither waits for nor freezes a scroll-driven animation", async () => {
    // A scroll timeline's animation never "finishes" while nobody scrolls.
    class ScrollTimeline {
      source = {};
    }
    const fade = {
      ...animation(1000, 60_000),
      timeline: new ScrollTimeline(),
    };
    const doc = {
      timeline: {},
      getAnimations: () => [fade],
      fonts: { ready: Promise.resolve() },
    } as unknown as Document;
    const router = fakeRouter();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame,
    });
    router.resolve("/sessions/new");
    await done;
    expect(fade.playState).toBe("running");
    expect(fade.paused).toBe(false);
  });

  it("does not hang when animation frames never come (occluded window)", async () => {
    const doc = {
      getAnimations: () => [],
      fonts: { ready: Promise.resolve() },
      visibilityState: "visible",
    } as unknown as Document;
    const router = fakeRouter();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame: () => undefined,
      frameFallbackMs: 20,
    });
    router.resolve("/sessions/new");
    await done;
  });

  it("uses timers at once while the document is hidden", async () => {
    const doc = {
      getAnimations: () => [],
      fonts: { ready: Promise.resolve() },
      visibilityState: "hidden",
    } as unknown as Document;
    const router = fakeRouter();
    const started = Date.now();
    const done = navigateAndSettle("/sessions/new", {
      router: router as never,
      doc,
      frame: () => undefined,
      frameFallbackMs: 10_000,
    });
    router.resolve("/sessions/new");
    await done;
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
