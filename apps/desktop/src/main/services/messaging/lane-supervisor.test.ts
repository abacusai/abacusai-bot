/**
 * The chat-app lane supervisor: a lane that should be connected and isn't
 * comes back by itself.
 *
 * A page load that failed while the OS still said "online" (DNS down after a
 * power cut or router restart) parked a lane as `error`, and nothing retried
 * it: the only retry waited on the OS online flag, and the gateway's restart
 * ladder ran only at launch or on a settings change. Lanes stayed dead for
 * hours with the app open, until a relaunch.
 */
import type {
  MessagingPlatformId,
  MessagingPlatformState,
} from "@abacus-ai/contract/messaging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LANE_CONNECTING_WATCHDOG_MS,
  LANE_GIVE_UP_MS,
  LANE_HINT_GAP_MS,
  LANE_NOTIFY_AFTER_MS,
  LANE_RETRY_CAP_MS,
  LANE_SHOW_AFTER_MS,
  LANE_STUCK_RETRY_MS,
  LaneSupervisor,
  laneRetryDelayMs,
  type LaneFailure,
} from "./lane-supervisor";

const ID: MessagingPlatformId = "whatsapp";

/** A gateway in miniature: each restart starts a lane that reports what `next` says. */
const harness = (
  next: () => { state: MessagingPlatformState; failure?: LaneFailure } | null
) => {
  const world = {
    enabled: true,
    diskFree: true,
    active: true,
    random: 0.5,
    restarts: [] as number[],
    notified: 0,
    toldUser: 0,
    hint: null as ((reason: string) => void) | null,
  };
  const supervisor: LaneSupervisor = new LaneSupervisor({
    now: () => Date.now(),
    random: () => world.random,
    shouldRun: () => world.enabled,
    restart: async (id) => {
      world.restarts.push(Date.now());
      supervisor.noteState(id, "disabled");
      supervisor.noteState(id, "connecting");
      const outcome = next();
      if (outcome != null)
        supervisor.noteState(id, outcome.state, outcome.failure);
    },
    diskSpaceBack: () => world.diskFree,
    userActive: () => world.active,
    notifyDown: () => {
      world.notified += 1;
    },
    tellNeedsUser: () => {
      world.toldUser += 1;
    },
    watchHints: (hint) => {
      world.hint = hint;
      return () => {
        world.hint = null;
      };
    },
    changed: () => {},
    log: () => {},
  });
  return { supervisor, world };
};

const unreachable = { state: "error", failure: { retry: "auto" } } as const;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("the retry delay", () => {
  it("doubles from 10 s to a 5 min cap, jittered ±50%", () => {
    expect(laneRetryDelayMs(1, 0)).toBe(5_000);
    expect(laneRetryDelayMs(1, 1)).toBe(15_000);
    expect(laneRetryDelayMs(2, 0.5)).toBe(20_000);
    expect(laneRetryDelayMs(3, 0.5)).toBe(40_000);
    expect(laneRetryDelayMs(50, 0.5)).toBe(LANE_RETRY_CAP_MS);
    expect(laneRetryDelayMs(50, 0)).toBe(LANE_RETRY_CAP_MS / 2);
    expect(laneRetryDelayMs(50, 1)).toBe(LANE_RETRY_CAP_MS * 1.5);
  });
});

describe("a lane whose page could not be reached", () => {
  it("is restarted on the backoff until it connects, then starts over", async () => {
    let outcome: { state: MessagingPlatformState; failure?: LaneFailure } =
      unreachable;
    const { supervisor, world } = harness(() => outcome);
    supervisor.noteState(ID, "connecting");
    supervisor.noteState(ID, "error", { retry: "auto" });

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(world.restarts).toEqual([10_000, 30_000, 70_000]);

    // DNS is back: the next try connects and the lane is no longer down.
    outcome = { state: "connected" };
    await vi.advanceTimersByTimeAsync(80_000);
    expect(world.restarts).toHaveLength(4);
    expect(supervisor.status(ID)).toBeNull();

    // A later failure starts from the first step again.
    outcome = unreachable;
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.restarts.at(-1)).toBe(150_000 + 10_000);
  });

  it("never waits longer than the cap plus its jitter", async () => {
    const { supervisor, world } = harness(() => unreachable);
    world.random = 1;
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    const gaps = world.restarts
      .slice(1)
      .map((at, i) => at - world.restarts[i]!);
    expect(Math.max(...gaps)).toBe(LANE_RETRY_CAP_MS * 1.5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(LANE_RETRY_FIRST_STEP);
  });

  it("is said in the pane only after 10 minutes down, with the next try", async () => {
    const { supervisor } = harness(() => unreachable);
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(LANE_SHOW_AFTER_MS - 1_000);
    expect(supervisor.status(ID)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    const status = supervisor.status(ID)!;
    expect(status.phase).toBe("scheduled");
    expect(status.nextTryAt).toBeGreaterThan(Date.now());
  });

  it("notifies once after an hour, and waits for the user to be back", async () => {
    const { supervisor, world } = harness(() => unreachable);
    world.active = false;
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(LANE_NOTIFY_AFTER_MS + 1_000);
    expect(world.notified).toBe(0);

    world.active = true;
    world.hint!("the app came to the front");
    world.hint!("the app came to the front");
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(world.notified).toBe(1);
  });

  it("stops after a day down; a hint or Try now still tries", async () => {
    const { supervisor, world } = harness(() => unreachable);
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(LANE_GIVE_UP_MS + 10 * 60_000);
    const count = world.restarts.length;
    // About one try per capped step over the day, then none.
    expect(count).toBeLessThan(LANE_GIVE_UP_MS / (LANE_RETRY_CAP_MS / 2) + 10);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(world.restarts).toHaveLength(count);
    expect(supervisor.status(ID)).toEqual({
      nextTryAt: null,
      phase: "stopped",
    });

    world.hint!("the app came to the front");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.restarts).toHaveLength(count + 1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(world.restarts).toHaveLength(count + 1);

    expect(supervisor.retryNow(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(world.restarts).toHaveLength(count + 2);
  });

  it("stops being retried once the user turns it off", async () => {
    const { supervisor, world } = harness(() => unreachable);
    supervisor.noteState(ID, "error", { retry: "auto" });
    world.enabled = false;
    supervisor.forget(ID);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(world.restarts).toHaveLength(0);
    expect(world.hint).toBeNull();
  });
});

describe("hints", () => {
  it("bring the next try forward and reset the backoff, at most once per 30 s", async () => {
    const { supervisor, world } = harness(() => unreachable);
    supervisor.noteState(ID, "error", { retry: "auto" });
    // Walk the backoff up to minutes between tries.
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    const before = world.restarts.length;
    const last = world.restarts.at(-1)!;

    // A network change: one try within seconds, not at the next long step.
    vi.setSystemTime(Math.max(Date.now(), last + LANE_HINT_GAP_MS));
    world.hint!("the network changed");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(world.restarts).toHaveLength(before + 1);

    // Focus spam after it: tries stay on the backoff's own pace, no faster.
    for (let i = 0; i < 120; i += 1) {
      world.hint!("the app came to the front");
      await vi.advanceTimersByTimeAsync(1_000);
    }
    const tries = world.restarts.slice(before);
    const gaps = tries.slice(1).map((at, i) => at - tries[i]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(20_000);
    expect(tries.length).toBeLessThanOrEqual(7);
  });
});

describe("a page that loads but never boots", () => {
  it("is tried every 30 minutes after three such tries, even when hinted", async () => {
    const stuck = {
      state: "error",
      failure: { retry: "auto", stuckBoot: true },
    } as const;
    const { supervisor, world } = harness(() => stuck);
    supervisor.noteState(ID, "error", stuck.failure);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(world.restarts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    const gaps = world.restarts
      .slice(3)
      .map((at, i) => at - world.restarts[i + 2]!);
    expect(gaps.every((gap) => gap === LANE_STUCK_RETRY_MS)).toBe(true);

    const count = world.restarts.length;
    world.hint!("the app came to the front");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.restarts).toHaveLength(count);
  });
});

describe("a lane on connecting that never settles", () => {
  it("is restarted once, then kept to the slow pace", async () => {
    // Each fresh lane stays on connecting: a boot slower than the watchdog.
    const { supervisor, world } = harness(() => null);
    supervisor.noteState(ID, "connecting");
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    const [first, second] = world.restarts;
    expect(first).toBeLessThan(LANE_CONNECTING_WATCHDOG_MS + 20_000);
    expect(second! - first!).toBeGreaterThanOrEqual(
      LANE_CONNECTING_WATCHDOG_MS + LANE_STUCK_RETRY_MS
    );
    expect(world.restarts.length).toBeLessThanOrEqual(5);
  });

  it("is restarted after 10 minutes with no change", async () => {
    const { supervisor, world } = harness(() => ({ state: "connected" }));
    supervisor.noteState(ID, "connecting");
    await vi.advanceTimersByTimeAsync(LANE_CONNECTING_WATCHDOG_MS - 1_000);
    expect(world.restarts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000 + 15_000);
    expect(world.restarts).toHaveLength(1);
    expect(supervisor.status(ID)).toBeNull();
  });

  it("is left alone once it leaves connecting", async () => {
    const { supervisor, world } = harness(() => null);
    supervisor.noteState(ID, "connecting");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    supervisor.noteState(ID, "needs_login");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(world.restarts).toHaveLength(0);
  });
});

describe("a failure only the user can fix", () => {
  it.each([
    ["logged out", "needs_login", undefined],
    ["a bad credential", "error", { retry: "user" }],
    ["an unlabelled error", "error", undefined],
  ] as const)(
    "%s is never retried by itself",
    async (_name, state, failure) => {
      const { supervisor, world } = harness(() => null);
      supervisor.noteState(ID, "connecting");
      supervisor.noteState(ID, state, failure);
      world.hint?.("the network changed");
      await vi.advanceTimersByTimeAsync(2 * LANE_GIVE_UP_MS);
      expect(world.restarts).toHaveLength(0);
      expect(world.notified).toBe(0);
      expect(supervisor.status(ID)).toBeNull();
    }
  );

  it("is retried when the user asks", async () => {
    const { supervisor, world } = harness(() => null);
    supervisor.noteState(ID, "error", { retry: "user" });
    expect(supervisor.retryNow(ID, LANE_HINT_GAP_MS)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    supervisor.noteState(ID, "error", { retry: "user" });
    // A second settings save straight after does not restart it again.
    expect(supervisor.retryNow(ID, LANE_HINT_GAP_MS)).toBe(false);
    expect(world.restarts).toHaveLength(1);
  });
});

describe("a lane the user opens while it waits for its next try", () => {
  it("keeps the page they opened: the pending try does not replace it", async () => {
    const { supervisor, world } = harness(() => null);
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(3_000);
    // Connect: the parked connector reloads its page and reports connecting.
    supervisor.noteState(ID, "connecting");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(world.restarts).toHaveLength(0);
    expect(supervisor.status(ID)).toBeNull();
    // Their try failing goes back to the backoff.
    supervisor.noteState(ID, "error", { retry: "auto" });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(world.restarts.length).toBeGreaterThan(0);
  });
});

describe("a refused certificate", () => {
  it("is retried three times, then waits for the user, who is told once", async () => {
    const cert = {
      state: "error",
      failure: { retry: "auto", cert: true },
    } as const;
    const { supervisor, world } = harness(() => cert);
    supervisor.noteState(ID, "error", cert.failure);
    await vi.advanceTimersByTimeAsync(LANE_SHOW_AFTER_MS + 60_000);
    expect(world.restarts).toHaveLength(3);
    expect(world.toldUser).toBe(1);
    expect(supervisor.status(ID)).toEqual({
      phase: "needs_user",
      nextTryAt: null,
    });

    // Hints do not retry it; Try now does, and is not told twice.
    world.hint!("the network changed");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(world.restarts).toHaveLength(3);
    expect(supervisor.retryNow(ID)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(world.restarts).toHaveLength(4);
    expect(world.toldUser).toBe(1);
  });

  it("goes back to the backoff when Try now meets a different failure", async () => {
    let outcome: { state: MessagingPlatformState; failure?: LaneFailure } = {
      state: "error",
      failure: { retry: "auto", cert: true },
    };
    const { supervisor, world } = harness(() => outcome);
    supervisor.noteState(ID, "error", { retry: "auto", cert: true });
    await vi.advanceTimersByTimeAsync(LANE_SHOW_AFTER_MS + 60_000);
    expect(supervisor.status(ID)?.phase).toBe("needs_user");

    // The network changed: Try now now fails to load, not on the certificate.
    outcome = unreachable;
    supervisor.retryNow(ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.status(ID)?.phase).toBe("scheduled");
    const tries = world.restarts.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.restarts.length).toBeGreaterThan(tries);
  });
});

describe("a full disk", () => {
  it("says it waits for disk space, not a next try", async () => {
    const { supervisor, world } = harness(() => null);
    world.diskFree = false;
    supervisor.noteState(ID, "error", { retry: "when_disk_free" });
    await vi.advanceTimersByTimeAsync(LANE_SHOW_AFTER_MS + 1_000);
    expect(supervisor.status(ID)).toEqual({ phase: "disk", nextTryAt: null });
  });

  it("is retried once space is back, not on the backoff", async () => {
    const { supervisor, world } = harness(() => ({ state: "connected" }));
    world.diskFree = false;
    supervisor.noteState(ID, "error", { retry: "when_disk_free" });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(world.restarts).toHaveLength(0);
    world.diskFree = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.restarts).toHaveLength(1);
  });
});

/** The shortest first step: 10 s at -50%. */
const LANE_RETRY_FIRST_STEP = 5_000;
