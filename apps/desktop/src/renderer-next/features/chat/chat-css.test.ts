/**
 * Codex r1 #16 / Claude r1 #33 (spec 02 §9.1): the chat's CSS motion follows
 * the app's preference the way the foundation resolves it: `prefs.motion.
 * reduce` is `data-reduce-motion` on <html> ("on" | "off" | "system"), "on"
 * reduces with the OS setting off, "off" keeps full motion with it on.
 *
 * jsdom has no media queries, so the cascade is evaluated here: the sheet is
 * parsed by the DOM, every rule whose selector matches applies in source
 * order, and a `prefers-reduced-motion: reduce` block applies only when the
 * OS setting is simulated on.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// Read from disk: the project's CSS pipeline only passes tokens.css through.
const css = readFileSync(join(import.meta.dirname, "chat.css"), "utf8");

type Pref = "on" | "off" | "system";

const declared = (element: Element, os: boolean, property: string): string => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  let value = "";
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        if (/prefers-reduced-motion:\s*reduce/.test(rule.media.mediaText)) {
          if (os) visit(rule.cssRules);
        } else visit(rule.cssRules);
        continue;
      }
      if (!(rule instanceof CSSStyleRule)) continue;
      let matches = false;
      try {
        matches = element.matches(rule.selectorText);
      } catch {
        matches = false;
      }
      if (!matches) continue;
      const next = rule.style.getPropertyValue(property);
      if (next !== "") value = next;
    }
  };
  visit(style.sheet!.cssRules);
  style.remove();
  return value;
};

const mount = (pref: Pref) => {
  document.documentElement.dataset.reduceMotion = pref;
  document.body.innerHTML = `
    <span class="chat-typing-dot"></span>
    <span class="shimmer">Thinking</span>
    <div data-slot="message-scroller-item" data-fresh></div>
    <div class="chat-prose chat-prose-streaming"><p>a</p><p id="last">b</p></div>`;
  return {
    dot: document.querySelector(".chat-typing-dot")!,
    shimmer: document.querySelector(".shimmer")!,
    fresh: document.querySelector("[data-fresh]")!,
    last: document.querySelector("#last")!,
  };
};

afterEach(() => {
  delete document.documentElement.dataset.reduceMotion;
  document.body.innerHTML = "";
});

const reduced = (pref: Pref, os: boolean): boolean => {
  const { dot, shimmer, fresh, last } = mount(pref);
  const states = [
    declared(dot, os, "animation") === "none",
    declared(shimmer, os, "animation") === "none" &&
      declared(shimmer, os, "--shimmer-image") === "none",
    declared(fresh, os, "translate") === "none",
    declared(last, os, "animation") === "none",
  ];
  // Every element agrees: all reduced or none.
  expect(new Set(states).size, `${pref}/${os}: ${states}`).toBe(1);
  return states[0]!;
};

describe("chat CSS reduced motion", () => {
  it("follows the OS when the preference is system", () => {
    expect(reduced("system", false)).toBe(false);
    expect(reduced("system", true)).toBe(true);
  });

  it("the in-app 'on' reduces with the OS setting off", () => {
    expect(reduced("on", false)).toBe(true);
    expect(reduced("on", true)).toBe(true);
  });

  it("the in-app 'off' keeps full motion with the OS setting on", () => {
    expect(reduced("off", true)).toBe(false);
    expect(reduced("off", false)).toBe(false);
  });

  it("diff colours target the highlighter's classes", () => {
    expect(css).toMatch(/\.th-inserted/);
    expect(css).toMatch(/\.th-deleted/);
    expect(css).not.toMatch(/\.token\.(inserted|deleted)/);
    expect(css).not.toMatch(/data-motion=/);
  });
});
