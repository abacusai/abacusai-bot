/**
 * The retry cap on the verify loop.
 *
 * The loop re-runs the project's tests after a run that touched code, and feeds
 * failures back as a follow-up. The cap is what stops that from being a cycle,
 * so the way it reads its own configuration is worth pinning: it used to become
 * NaN for any malformed value, and `retriesUsed >= NaN` is false for every
 * number — a cap that never caps.
 */
import { describe, expect, it } from "vitest";

import { resolveMaxRetries } from "./verify-loop.js";

describe("how many follow-ups the loop may send", () => {
  it("defaults to one when nothing is set", () => {
    expect(resolveMaxRetries(undefined)).toBe(1);
  });

  it("honours a number that was set deliberately", () => {
    expect(resolveMaxRetries("3")).toBe(3);
    expect(resolveMaxRetries("0")).toBe(0);
  });

  it("treats an empty-but-set variable as unset, not as zero", () => {
    // Number('') is 0, which would switch verification off entirely for anyone
    // who exported the variable without a value — the same trap the docs warn
    // about for API keys.
    expect(resolveMaxRetries("")).toBe(1);
    expect(resolveMaxRetries("   ")).toBe(1);
  });

  it("falls back to the default for a value that is not a number", () => {
    // The bug: Number('two') is NaN, and every `retriesUsed >= NaN` comparison
    // is false, so the guard let every settled run start another verification.
    expect(resolveMaxRetries("two")).toBe(1);
    expect(resolveMaxRetries("NaN")).toBe(1);
    expect(resolveMaxRetries("Infinity")).toBe(1);
  });

  it("never yields a value that makes the guard vacuous", () => {
    for (const raw of [
      undefined,
      "",
      "  ",
      "1",
      "3",
      "two",
      "NaN",
      "Infinity",
      "-1",
    ]) {
      const max = resolveMaxRetries(raw);

      // The guard is `retriesUsed >= MAX_RETRIES`. It has to be answerable.
      expect(Number.isFinite(max)).toBe(true);
      expect(typeof (0 >= max)).toBe("boolean");
    }
  });
});
