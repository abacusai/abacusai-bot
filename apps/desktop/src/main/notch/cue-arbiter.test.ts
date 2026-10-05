/**
 * R6-T22 (main side, spec 06 §14.2): central cue arbitration. Exactly one
 * `play: true` per cue id, never to an ineligible claimant (rechecked at
 * grant time), none for the focused main window's visible thread, and the
 * procedures through the real router.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "../rpc/testing";
import {
  CueArbiter,
  mainOnlyCueWindows,
  type CueArbiterWindows,
} from "./cue-arbiter";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const MAIN = 1;
const NOTCH_A = 2;
const NOTCH_B = 3;
const LOCKED = 4;

const makeWindows = () => {
  const eligible = new Set([MAIN, NOTCH_A, NOTCH_B]);
  const facts = {
    focused: true,
    audible: MAIN as number | null,
    eligible,
  };
  const windows: CueArbiterWindows = {
    mainRendererId: () => MAIN,
    mainFocused: () => facts.focused,
    audible: () => facts.audible,
    canPlay: (id) => facts.eligible.has(id),
  };
  return { facts, windows };
};

/** Shuffles with a seeded generator (deterministic runs). */
const shuffle = <T>(items: T[], seed: number): T[] => {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    const pick = state % (index + 1);
    [out[index], out[pick]] = [out[pick]!, out[index]!];
  }
  return out;
};

describe("CueArbiter (spec 06 §14.2)", () => {
  it("grants the audible document's first claim at once; every other claim is false", async () => {
    vi.useFakeTimers();
    const { windows } = makeWindows();
    const arbiter = new CueArbiter({ windows });
    const notch = arbiter.claim(NOTCH_A, "done:run-1", "s1");
    await expect(arbiter.claim(MAIN, "done:run-1", "s1")).resolves.toBe(true);
    await expect(notch).resolves.toBe(false);
    await expect(arbiter.claim(MAIN, "done:run-1", "s1")).resolves.toBe(false);
    await expect(arbiter.claim(NOTCH_B, "done:run-1", "s1")).resolves.toBe(
      false
    );
  });

  it("falls back after 1 s to the earliest claimant still eligible, skipping one disposed meanwhile", async () => {
    vi.useFakeTimers();
    const { facts, windows } = makeWindows();
    const arbiter = new CueArbiter({ windows });
    const first = arbiter.claim(NOTCH_A, "needs-you:p1", "s2");
    const second = arbiter.claim(NOTCH_B, "needs-you:p1", "s2");
    // A locked document never waits: false at once.
    await expect(arbiter.claim(LOCKED, "needs-you:p1", "s2")).resolves.toBe(
      false
    );
    // NOTCH_A is disposed during the fallback window.
    facts.eligible.delete(NOTCH_A);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(arbiter.decision("needs-you:p1")).toBe("granted");
    // The audible document arriving late gets nothing.
    await expect(arbiter.claim(MAIN, "needs-you:p1", "s2")).resolves.toBe(
      false
    );
  });

  it("drops the cue when no claimant is eligible at grant time", async () => {
    vi.useFakeTimers();
    const { facts, windows } = makeWindows();
    const arbiter = new CueArbiter({ windows });
    const only = arbiter.claim(NOTCH_A, "failed:r2", null);
    facts.eligible.delete(NOTCH_A);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(only).resolves.toBe(false);
    expect(arbiter.decision("failed:r2")).toBe("dropped");
  });

  it("suppresses a cue for the focused main window's visible thread, and never grants it later", async () => {
    vi.useFakeTimers();
    const { facts, windows } = makeWindows();
    const arbiter = new CueArbiter({ windows });
    arbiter.setVisibleThread(MAIN, "s3");
    const waiting = arbiter.claim(NOTCH_A, "received:r3", "s3");
    await expect(arbiter.claim(MAIN, "received:r3", "s3")).resolves.toBe(false);
    await expect(waiting).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(arbiter.decision("received:r3")).toBe("suppressed");

    // Unfocused, the same thread is not silenced.
    facts.focused = false;
    await expect(arbiter.claim(MAIN, "received:r4", "s3")).resolves.toBe(true);
  });

  it("shuffled deliveries: exactly one play per cue across documents", async () => {
    vi.useFakeTimers();
    for (let seed = 1; seed <= 25; seed += 1) {
      const { facts, windows } = makeWindows();
      facts.audible = seed % 3 === 0 ? NOTCH_B : MAIN;
      const arbiter = new CueArbiter({ windows });
      const claims = shuffle(
        [MAIN, NOTCH_A, NOTCH_B, LOCKED].flatMap((id) =>
          ["done:a", "done:b", "needs-you:c"].map((cue) => ({ id, cue }))
        ),
        seed
      ).map(({ id, cue }) => ({ cue, play: arbiter.claim(id, cue, null) }));
      await vi.advanceTimersByTimeAsync(1_000);
      const results = await Promise.all(
        claims.map(async ({ cue, play }) => ({ cue, play: await play }))
      );
      for (const cue of ["done:a", "done:b", "needs-you:c"])
        expect(
          results.filter((result) => result.cue === cue && result.play)
        ).toHaveLength(1);
    }
  });

  it("the fallback rechecks focused-thread silence: main focusing the thread during the wait silences the cue", async () => {
    vi.useFakeTimers();
    const { facts, windows } = makeWindows();
    facts.focused = false;
    const arbiter = new CueArbiter({ windows });
    const waiting = arbiter.claim(NOTCH_A, "needs-you:p9", "s9");
    // During the 1 s wait main focuses the cue's thread.
    arbiter.setVisibleThread(MAIN, "s9");
    facts.focused = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(false);
    expect(arbiter.decision("needs-you:p9")).toBe("suppressed");
  });

  it("a decided cue evicted by the count bound is never granted again within its TTL", async () => {
    let now = 0;
    const { windows } = makeWindows();
    const arbiter = new CueArbiter({
      windows,
      maxEntries: 3,
      ttlMs: 60_000,
      now: () => now,
    });
    await expect(arbiter.claim(MAIN, "done:first", null)).resolves.toBe(true);
    for (let index = 0; index < 10; index += 1)
      void arbiter.claim(MAIN, `done:${index}`, null);
    expect(arbiter.decision("done:first")).toBeNull();
    await expect(arbiter.claim(MAIN, "done:first", null)).resolves.toBe(false);
    // Past its TTL the tombstone goes too.
    now = 120_000;
    void arbiter.claim(MAIN, "done:later", null);
    await expect(arbiter.claim(MAIN, "done:first", null)).resolves.toBe(true);
  });

  it("a window's visibility report is forgotten when its webContents is destroyed", () => {
    const { windows } = makeWindows();
    const gone = new Map<number, () => void>();
    const arbiter = new CueArbiter({
      windows,
      onWindowGone: (id, forget) => gone.set(id, forget),
    });
    for (const generation of [11, 12, 13]) {
      arbiter.setVisibleThread(generation, "s1");
      arbiter.setVisibleThread(generation, "s2");
      gone.get(generation)!();
    }
    expect(gone.size).toBe(3);
    expect(arbiter.trackedWindows).toBe(0);
  });

  it("the decision map is bounded", () => {
    const { windows } = makeWindows();
    const arbiter = new CueArbiter({ windows, maxEntries: 3 });
    for (let index = 0; index < 10; index += 1)
      void arbiter.claim(MAIN, `done:${index}`, null);
    expect(arbiter.decision("done:0")).toBeNull();
    expect(arbiter.decision("done:9")).toBe("granted");
  });
});

describe("window.claimCue and window.visibleThread over the router", () => {
  it("grants the main renderer, suppresses its visible thread, and refuses visibleThread from another window", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const windowState = { focused: true, fullScreen: false, maximized: false };
    const deps = fakeDeps({
      windows: { mainRendererId: () => 1, state: () => windowState },
    });
    const main = connectInProcess(deps, { webContentsId: 1 }).client;
    await expect(
      main.window.claimCue({ cueId: "done:r1", threadId: "s1" })
    ).resolves.toEqual({ play: true });

    await main.window.visibleThread({ threadId: "s2" });
    await expect(
      main.window.claimCue({ cueId: "done:r2", threadId: "s2" })
    ).resolves.toEqual({ play: false });

    const other = connectInProcess(deps, { webContentsId: 7 }).client;
    await expect(
      other.window.visibleThread({ threadId: null })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // A document that cannot play is answered at once.
    await expect(
      other.window.claimCue({ cueId: "done:r3", threadId: null })
    ).resolves.toEqual({ play: false });
    expect(mainOnlyCueWindows(deps.windows).audible()).toBe(1);
  });

  it("system.funnelStep { once } routes to the persisted first-time report", async () => {
    const calls: unknown[][] = [];
    const deps = fakeDeps({
      app: {
        reportFunnelStep: (...args: unknown[]) => {
          calls.push(args);
        },
      },
    });
    const client = connectInProcess(deps).client;
    await client.system.funnelStep({ step: "onboarding_done", once: true });
    await client.system.funnelStep({ step: "screen_auth" });
    expect(calls).toEqual([
      ["onboarding_done", undefined, true],
      ["screen_auth", undefined],
    ]);
  });
});
