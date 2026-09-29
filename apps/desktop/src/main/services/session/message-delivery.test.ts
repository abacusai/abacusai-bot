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

import { deliverMessage, type DeliveryPorts } from "./message-delivery";

/** A CLI that can be down, started, and become ready after N ready-checks. */
const ports = (options: {
  runningAt?: number | null;
  startSucceeds?: boolean;
  sendSucceedsWhenRunning?: boolean;
}): DeliveryPorts & { sends: number; starts: number } => {
  const {
    runningAt = null,
    startSucceeds = true,
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
    start: async (): Promise<boolean> => {
      state.starts += 1;
      started = startSucceeds;
      return startSucceeds;
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
      start: vi.fn(async () => true),
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
        return true;
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
    const p = ports({ runningAt: 0, startSucceeds: false });

    await expect(deliverMessage(p)).resolves.toBe("undeliverable");

    // The caller has an echo on screen; one failed dispatch, and no retry.
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
