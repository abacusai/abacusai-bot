/** R3-T27 (jsdom half): every shape, mood and accessory renders. */
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  AVATAR_ACCESSORIES,
  AVATAR_SHAPES,
  LIFECYCLE_MOODS,
  REACTION_MOODS,
  type Look,
} from "#renderer/lib/bots/avatar";

import { ACCENT_OUTLINE_CLASS, BotAvatar } from ".";

const preference = vi.hoisted(() => ({ reduced: false }));
vi.mock("#renderer/lib/motion", async (original) => ({
  ...(await original<typeof import("#renderer/lib/motion")>()),
  useMotionPreference: () => (preference.reduced ? "reduced" : "full"),
}));
/** vitest processes only tokens.css as CSS (`?raw` is empty here): read the file. */
const { readFileSync } = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");
const css = readFileSync("src/components/bot-avatar/moods.css", "utf8");

const look = (patch: Partial<Look> = {}): Look => ({
  shape: "blob",
  color: "#4ade80",
  accessory: "none",
  ...patch,
});

describe("BotAvatar", () => {
  it("renders every shape: CSS bodies or a path, ears on bunny/cat/bear", () => {
    for (const shape of AVATAR_SHAPES) {
      const { container, unmount } = render(
        <BotAvatar look={look({ shape })} size={36} />
      );
      const root = container.querySelector('[data-slot="bot-avatar"]')!;
      expect(root.getAttribute("data-shape")).toBe(shape);
      const body = root.querySelector(".bav-body");
      const svg = root.querySelector(".bav-svg");
      expect(body != null || svg != null).toBe(true);
      if (["bunny", "cat", "bear"].includes(shape))
        expect(svg?.querySelector(".bav-ears")).not.toBeNull();
      unmount();
    }
  });

  it("renders every mood with a face, and the mood's extra", () => {
    for (const mood of [...LIFECYCLE_MOODS, ...REACTION_MOODS]) {
      const { container, unmount } = render(
        <BotAvatar look={look()} mood={mood} size={56} />
      );
      const root = container.querySelector(".bav")!;
      expect(root.getAttribute("data-mood")).toBe(mood);
      expect(root.querySelectorAll(".bav-eye")).toHaveLength(2);
      if (mood === "asleep")
        expect(root.querySelectorAll(".bav-zz")).toHaveLength(2);
      if (mood === "waiting")
        expect(root.querySelectorAll(".bav-eye path").length).toBeGreaterThan(
          2
        );
      if (mood === "blocked")
        expect(root.querySelector(".bav-sweat")).not.toBeNull();
      unmount();
    }
  });

  it("renders every accessory", () => {
    for (const accessory of AVATAR_ACCESSORIES) {
      const { container, unmount } = render(
        <BotAvatar look={look({ accessory })} size={36} />
      );
      const acc = container.querySelector(".bav-acc");
      if (accessory === "none") expect(acc).toBeNull();
      else expect(acc?.getAttribute("data-accessory")).toBe(accessory);
      unmount();
    }
  });

  it("is decorative unless labelled", () => {
    const { container, rerender } = render(
      <BotAvatar look={look()} size={22} />
    );
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe(
      "true"
    );
    rerender(<BotAvatar look={look()} size={22} label="Scout" />);
    expect(container.firstElementChild?.getAttribute("role")).toBe("img");
    expect(container.firstElementChild?.getAttribute("aria-label")).toBe(
      "Scout"
    );
  });

  it("animates only when asked; reduced motion stops every keyframe in CSS", () => {
    const { container, rerender } = render(
      <BotAvatar look={look()} mood="working" size={36} />
    );
    expect(container.firstElementChild?.hasAttribute("data-animate")).toBe(
      false
    );
    rerender(<BotAvatar look={look()} mood="working" size={36} animate />);
    expect(container.firstElementChild?.hasAttribute("data-animate")).toBe(
      true
    );
    // Every animation rule is gated on [data-animate].
    for (const rule of css.match(/[^{}]+\{[^{}]*\banimation:[^{}]*\}/g) ?? []) {
      const selector = rule.slice(0, rule.indexOf("{"));
      if (/animation:\s*none/.test(rule)) continue;
      expect(selector).toContain("[data-animate]");
    }
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*html:not\(\[data-reduce-motion="off"\]\) \.bav/
    );
    expect(css).toContain('html[data-reduce-motion="on"] .bav');
  });

  it("simplifies at 16/24px and keeps readable features at larger sizes", () => {
    for (const size of [16, 24, 32, 44, 72, 160]) {
      const { container, unmount } = render(
        <BotAvatar look={look()} mood="happy" size={size} animate />
      );
      const root = container.querySelector(".bav")!;
      expect(root.getAttribute("data-optical")).toBe(
        size <= 24 ? "tiny" : "full"
      );
      expect(root.querySelector(".bav-cheeks") != null).toBe(size > 24);
      if (size <= 24) {
        expect(root.hasAttribute("data-animate")).toBe(false);
        expect(root.querySelector(".bav-x")).toBeNull();
      }
      unmount();
    }
  });

  it("reduced motion renders the complete static pose even when animation is requested", () => {
    preference.reduced = true;
    const { container } = render(
      <BotAvatar look={look()} mood="talking" size={72} animate />
    );
    expect(container.querySelector(".bav")?.hasAttribute("data-animate")).toBe(
      false
    );
    expect(container.querySelector(".bav-mouth")?.getAttribute("d")).toContain(
      "Q"
    );
    preference.reduced = false;
  });

  it("exports the light-theme outline class", () => {
    expect(ACCENT_OUTLINE_CLASS).toBe("accent-outline");
    expect(css).toMatch(
      /\.accent-outline \{\s*border: 1px solid var\(--muted-foreground\)/
    );
    expect(css).toMatch(
      /\.dark \.accent-outline \{\s*border-color: transparent/
    );
  });
});
