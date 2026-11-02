/**
 * The message must reach an agent, or the user must be told it did not.
 *
 * The bug this covers: a session whose CLI had died (crashed mid-turn, killed
 * with the app, start-retries exhausted an hour earlier) accepted sends and
 * dropped them. The dispatch returned false, the boolean went nowhere, and the
 * transcript kept the echo. You typed, and nothing ever happened.
 *
 * The ordering is the whole contract, so it is what these pin: never send
 * twice, never send before the revived CLI is ready, and give up rather than
 * wait forever.
 */
import { describe, expect, it, vi } from "vitest";

import {
  deliverMessage,
  type DeliveryPorts,
  type StartOutcome,
} from "./message-delivery";

/**
 * A CLI that can be down, started, and become ready after N ready-checks.
 * `starts` is how each start goes, in order; the last one repeats.
 */
const ports = (options: {
  runningAt?: number | null;
  starts?: StartOutcome[];
  sendSucceedsWhenRunning?: boolean;
}): DeliveryPorts & { sends: number; starts: number } => {
  const {
    runningAt = null,
    starts = ["started"],
    sendSucceedsWhenRunning = true,
  } = options;
  let started = false;
  let readyChecks = 0;

  const state = {
    sends: 0,
    starts: 0,
    send: (): boolean => {
      state.sends += 1;
      return (
        started &&
        sendSucceedsWhenRunning &&
        runningAt != null &&
        readyChecks >= runningAt
      );
    },
    start: async (): Promise<StartOutcome> => {
      const outcome = starts[Math.min(state.starts, starts.length - 1)]!;
      state.starts += 1;
      started = outcome === "started";
      return outcome;
    },
    isRunning: (): boolean => {
      const ready = runningAt != null && readyChecks >= runningAt;
      readyChecks += 1;
      return started && ready;
    },
    delay: async (): Promise<void> => {},
  };
  return state;
};

describe("delivering to a live session", () => {
  it("sends once and does not touch the process", async () => {
    const p = {
      send: vi.fn(() => true),
      start: vi.fn(async (): Promise<StartOutcome> => "started"),
      isRunning: vi.fn(() => true),
      delay: vi.fn(async () => {}),
    };

    await expect(deliverMessage(p)).resolves.toBe("delivered");

    expect(p.send).toHaveBeenCalledTimes(1);
    expect(p.start).not.toHaveBeenCalled();
  });
});

describe("delivering to a session whose CLI is gone", () => {
  it("restarts it and delivers once it is ready", async () => {
    const p = ports({ runningAt: 3 });

    await expect(deliverMessage(p)).resolves.toBe("restarted");

    expect(p.starts).toBe(1);
    // One failed dispatch, then exactly one more after the CLI came up.
    expect(p.sends).toBe(2);
  });

  it("waits for ready rather than sending into a half-spawned CLI", async () => {
    // Sending before `ready` is what the original bug looked like from the
    // other side: stdin is not wired and the command is dropped silently.
    const order: string[] = [];
    let ready = false;
    const p: DeliveryPorts = {
      send: () => {
        order.push(ready ? "send-when-ready" : "send-too-early");
        return ready;
      },
      start: async () => {
        order.push("start");
        return "started";
      },
      isRunning: () => {
        const was = ready;
        ready = true;
        return was;
      },
      delay: async () => {},
    };

    await expect(deliverMessage(p)).resolves.toBe("restarted");
    expect(order).toEqual(["send-too-early", "start", "send-when-ready"]);
  });

  it("reports undeliverable when the session cannot be started", async () => {
    const p = ports({ runningAt: 0, starts: ["failed"] });

    await expect(deliverMessage(p)).resolves.toBe("undeliverable");

    // The caller has an echo on screen; one failed dispatch, never resent.
    expect(p.sends).toBe(1);
    expect(p.starts).toBe(2);
  });

  it("starts once more when the first start ran out of time, then delivers", async () => {
    // A slow machine's cold start: nothing reached an agent, so a second
    // start is safe, and the message goes once, to the one that came up.
    const p = ports({ runningAt: 0, starts: ["timed_out", "started"] });

    await expect(deliverMessage(p)).resolves.toBe("restarted");

    expect(p.starts).toBe(2);
    expect(p.sends).toBe(2);
  });

  it("reports a start that ran out of time twice as that, not as undeliverable", async () => {
    const p = ports({ runningAt: 0, starts: ["timed_out"] });

    await expect(deliverMessage(p)).resolves.toBe("agent_start_timeout");

    expect(p.starts).toBe(2);
    expect(p.sends).toBe(1);
  });

  it("gives up when the restarted CLI never becomes ready", async () => {
    const p = ports({ runningAt: null });

    await expect(deliverMessage(p)).resolves.toBe("undeliverable");

    expect(p.starts).toBe(1);
    expect(p.sends).toBe(1);
  });

  it("does not keep resending when a ready CLI refuses the message", async () => {
    const p = ports({ runningAt: 0, sendSucceedsWhenRunning: false });

    await expect(deliverMessage(p)).resolves.toBe("undeliverable");

    expect(p.sends).toBe(2);
  });
});
