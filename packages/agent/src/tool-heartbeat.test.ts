/**
 * The turn that got killed for working too quietly.
 *
 * A user ran a crawl through bash. It wrote nothing to stdout for ten minutes,
 * so the agent emitted nothing, so the desktop's watchdog concluded the agent
 * was wedged and ended the turn — "Agent timed out: nothing came back for 10
 * minutes while running bash (...)". The command was fine; the only thing wrong
 * was that working silently and being dead looked identical from outside.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import type { DesktopEvent } from "./protocol.js";
import {
  ToolHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  MAX_VOUCHED_RUNTIME_MS,
} from "./tool-heartbeat.js";

const INTERVAL = 1_000;

let emitted: DesktopEvent[];
let heartbeat: ToolHeartbeat;

beforeEach(() => {
  vi.useFakeTimers();
  emitted = [];
  heartbeat = new ToolHeartbeat((event) => emitted.push(event), INTERVAL);
});

afterEach(() => {
  vi.useRealTimers();
});

const beats = (): DesktopEvent[] =>
  emitted.filter((e) => e.type === "heartbeat");

describe("a tool that runs without saying anything", () => {
  it("keeps reporting for as long as the call is outstanding", () => {
    heartbeat.started("call-1");

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(beats()).toHaveLength(5);
  });

  it("outlasts the watchdog it exists to satisfy", () => {
    // The regression, in the proportions that produced it: a bash call may run
    // for 600s and the watchdog fires at 600s. Whatever the two numbers are,
    // the call has to still be reporting when the watchdog would have given up.
    const realistic = new ToolHeartbeat((event) => emitted.push(event));

    realistic.started("call-1");
    vi.advanceTimersByTime(10 * 60_000);

    expect(beats().length).toBeGreaterThanOrEqual(
      (10 * 60_000) / HEARTBEAT_INTERVAL_MS - 1
    );

    realistic.clear();
  });

  it("says how many calls are outstanding", () => {
    heartbeat.started("call-1");
    heartbeat.started("call-2");

    vi.advanceTimersByTime(INTERVAL);

    expect(beats()).toEqual([{ type: "heartbeat", runningTools: 2 }]);
  });
});

describe("stopping when there is nothing to report", () => {
  it("goes quiet once the call ends", () => {
    heartbeat.started("call-1");
    vi.advanceTimersByTime(INTERVAL * 2);
    heartbeat.ended("call-1");

    vi.advanceTimersByTime(INTERVAL * 10);

    expect(beats()).toHaveLength(2);
  });

  it("keeps beating while any other call is still running", () => {
    heartbeat.started("call-1");
    heartbeat.started("call-2");
    heartbeat.ended("call-1");

    vi.advanceTimersByTime(INTERVAL);

    expect(beats()).toEqual([{ type: "heartbeat", runningTools: 1 }]);
  });

  it("never beats before a call has started", () => {
    vi.advanceTimersByTime(INTERVAL * 10);

    expect(beats()).toHaveLength(0);
  });

  it("stops when the turn is torn down mid-call", () => {
    // An aborted turn, or one whose end event never arrived. Left alone this is
    // what would keep a finished session beating for the life of the process,
    // holding a dead turn open in the desktop.
    heartbeat.started("call-1");
    heartbeat.clear();

    vi.advanceTimersByTime(INTERVAL * 10);

    expect(beats()).toHaveLength(0);
    expect(heartbeat.size).toBe(0);
  });

  it("does not double-count a call that starts twice", () => {
    heartbeat.started("call-1");
    heartbeat.started("call-1");
    heartbeat.ended("call-1");

    vi.advanceTimersByTime(INTERVAL * 5);

    expect(beats()).toHaveLength(0);
  });

  it("ignores an end for a call it never saw start", () => {
    heartbeat.started("call-1");
    heartbeat.ended("call-unknown");

    vi.advanceTimersByTime(INTERVAL);

    expect(beats()).toEqual([{ type: "heartbeat", runningTools: 1 }]);
  });

  it("can be restarted after being cleared", () => {
    heartbeat.started("call-1");
    heartbeat.clear();
    heartbeat.started("call-2");

    vi.advanceTimersByTime(INTERVAL);

    expect(beats()).toEqual([{ type: "heartbeat", runningTools: 1 }]);
  });

  it("runs one timer no matter how many calls overlap", () => {
    // Two timers would double the rate and, worse, leak one on clear().
    heartbeat.started("call-1");
    heartbeat.started("call-2");
    heartbeat.started("call-3");

    vi.advanceTimersByTime(INTERVAL);

    expect(beats()).toHaveLength(1);
  });
});

/**
 * The heartbeat vouches for a call; it does not vouch for the agent forever.
 *
 * Several tools cannot be killed — the budget extension can warn that
 * `document` or `delegate_task` has overrun but not stop it. If a hung one
 * could be vouched for indefinitely, the watchdog would never fire and the
 * session would be unendable except by pressing Stop. That is a worse failure
 * than the one this whole mechanism exists to fix, so the vouching runs out.
 */
describe("a call that has run implausibly long", () => {
  const MAX = 60_000;

  const bounded = (): { hb: ToolHeartbeat; beats: () => number } => {
    const seen: DesktopEvent[] = [];
    const hb = new ToolHeartbeat((e) => seen.push(e), INTERVAL, MAX);

    return {
      hb,
      beats: () => seen.filter((e) => e.type === "heartbeat").length,
    };
  };

  it("stops vouching once the call passes the limit", () => {
    const { hb, beats } = bounded();
    hb.started("call-1");

    vi.advanceTimersByTime(MAX * 3);
    const afterLimit = beats();
    vi.advanceTimersByTime(MAX * 3);

    expect(beats()).toBe(afterLimit);
  });

  it("lets the watchdog have its say rather than beating forever", () => {
    const { hb, beats } = bounded();
    hb.started("call-1");

    vi.advanceTimersByTime(MAX * 10);

    // Bounded by the limit, not by how long we waited.
    expect(beats()).toBeLessThanOrEqual(MAX / INTERVAL);
  });

  it("keeps vouching for a newer call alongside a stale one", () => {
    // One wedged call must not silence the heartbeat for a healthy sibling.
    const { hb, beats } = bounded();
    hb.started("stale");
    vi.advanceTimersByTime(MAX * 2);
    const before = beats();
    hb.started("fresh");

    vi.advanceTimersByTime(INTERVAL * 2);

    expect(beats()).toBeGreaterThan(before);
  });

  it("counts only the calls it is still vouching for", () => {
    const seen: DesktopEvent[] = [];
    const hb = new ToolHeartbeat((e) => seen.push(e), INTERVAL, MAX);
    hb.started("stale");
    vi.advanceTimersByTime(MAX * 2);
    seen.length = 0;
    hb.started("fresh");

    vi.advanceTimersByTime(INTERVAL);

    expect(seen.filter((e) => e.type === "heartbeat")).toEqual([
      { type: "heartbeat", runningTools: 1 },
    ]);
  });

  it("leaves room for the slowest tool that legitimately exists", () => {
    // 900s is the longest budget in tool-timeouts.ts. The limit has to be
    // clear of it, or an honest document build would be cut off.
    expect(MAX_VOUCHED_RUNTIME_MS).toBeGreaterThan(900 * 1_000);
  });
});
