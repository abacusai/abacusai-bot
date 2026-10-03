import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NOTCH_BANNER_SUPPRESSION,
  NotchNotificationPolicy,
} from "./notifications";
afterEach(() => vi.useRealTimers());
describe("R6-T28 attention notification policy", () => {
  it("ships suppression off and sends immediately even with a visible companion", () => {
    expect(NOTCH_BANNER_SUPPRESSION).toBe(false);
    const show = vi.fn();
    new NotchNotificationPolicy({
      enabled: () => true,
      presented: () => true,
    }).notify({ kind: "needs-you", dedupeKey: "x" }, show);
    expect(show).toHaveBeenCalledOnce();
  });
  it("deduplicates replayed attention centrally", () => {
    const show = vi.fn();
    const policy = new NotchNotificationPolicy({
      enabled: () => false,
      presented: () => false,
    });
    policy.notify({ kind: "done", dedupeKey: "x" }, show);
    policy.notify({ kind: "done", dedupeKey: "x" }, show);
    expect(show).toHaveBeenCalledOnce();
  });
  it("flag-on hold only drops a seen presentation within its deadline", async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    let presented = false;
    const policy = new NotchNotificationPolicy(
      { enabled: () => true, presented: () => presented },
      true
    );
    policy.notify({ kind: "needs-you", dedupeKey: "x" }, show);
    await vi.advanceTimersByTimeAsync(1499);
    expect(show).not.toHaveBeenCalled();
    presented = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(show).not.toHaveBeenCalled();
    policy.notify({ kind: "needs-you", dedupeKey: "y" }, show);
    presented = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(show).toHaveBeenCalledOnce();
    policy.dispose();
  });
  it("ordinary done and failed notifications bypass the hold", () => {
    const show = vi.fn();
    const policy = new NotchNotificationPolicy(
      { enabled: () => true, presented: () => true },
      true
    );
    policy.notify({ kind: "done", dedupeKey: "x" }, show);
    policy.notify({ kind: "failed", dedupeKey: "y" }, show);
    expect(show).toHaveBeenCalledTimes(2);
  });
});
