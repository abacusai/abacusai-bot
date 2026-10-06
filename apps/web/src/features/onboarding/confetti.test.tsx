/**
 * Confetti is a burst, not a loop: seven palette pieces, staggered, gone
 * after one 2.4 s run plus the last delay; nothing under reduced motion.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AVATAR_PALETTE } from "#renderer/lib/bots/avatar";
import { hatch } from "#renderer/lib/motion";

import { CONFETTI_RUN_MS, Confetti } from "./confetti";

const { readFileSync } = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");

describe("Confetti", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops seven palette pieces across the spread with distinct delays", () => {
    const { container } = render(<Confetti spread={300} reduced={false} />);
    const pieces = [
      ...container.querySelectorAll<HTMLElement>("[data-slot=confetti] i"),
    ];
    expect(pieces).toHaveLength(hatch.confettiPieces);
    const delays = pieces.map((p) => parseFloat(p.style.animationDelay));
    expect(new Set(delays).size).toBe(pieces.length);
    expect(Math.max(...delays)).toBeLessThanOrEqual(1.2);
    const hexes = new Set<string>(AVATAR_PALETTE.map((entry) => entry.hex));
    for (const piece of pieces) {
      const rgb = piece.style.background.match(/\d+/g)!.map(Number);
      const hex =
        "#" + rgb.map((n) => n.toString(16).padStart(2, "0")).join("");
      expect(hexes.has(hex)).toBe(true);
    }
    expect(pieces[0]!.style.left).toBe("calc(50% - 150px)");
    expect(pieces.at(-1)!.style.left).toBe("calc(50% + 150px)");
  });

  it("removes itself after one run", () => {
    const { container } = render(<Confetti reduced={false} />);
    expect(container.querySelector("[data-slot=confetti]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(CONFETTI_RUN_MS - 1));
    expect(container.querySelector("[data-slot=confetti]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector("[data-slot=confetti]")).toBeNull();
    expect(CONFETTI_RUN_MS).toBe(hatch.confettiMs + 1100);
  });

  it("renders nothing under reduced motion", () => {
    const { container } = render(<Confetti reduced={true} />);
    expect(container.querySelector("[data-slot=confetti]")).toBeNull();
  });

  it("runs the CSS keyframes once (both), not forever", () => {
    const css = readFileSync("src/features/onboarding/onboarding.css", "utf8");
    const rule = css.match(/\.onboarding-confetti i \{[^}]*\}/)![0];
    expect(rule).toMatch(/animation: onboarding-confetti 2\.4s [^;]*both;/);
    expect(rule).not.toContain("infinite");
    expect(css).toMatch(
      /@keyframes onboarding-confetti \{[^]*?translateY\(140px\) rotate\(320deg\)/
    );
  });
});
