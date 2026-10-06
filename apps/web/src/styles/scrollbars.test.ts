/**
 * Scrollbars (V8): one themed, thin, rounded thumb app-wide, invisible until
 * the pointer is over the scroller; Chromium through `::-webkit-scrollbar`,
 * other engines through the standard properties, and `.no-scrollbar` kept
 * for the places that hide theirs on purpose.
 */
import { describe, expect, it } from "vitest";

import tokensCss from "./tokens.css?raw";

describe("themed scrollbars", () => {
  it("declares the thumb from the theme's ink, rounded and thin", () => {
    expect(tokensCss).toMatch(
      /--scrollbar-thumb: color-mix\(in oklab, var\(--foreground\) \d+%, transparent\);/
    );
    expect(tokensCss).toMatch(
      /::-webkit-scrollbar \{\s*width: var\(--scrollbar-size\);\s*height: var\(--scrollbar-size\);/
    );
    expect(tokensCss).toMatch(
      /::-webkit-scrollbar-thumb \{[^}]*border-radius: 999px;/
    );
    expect(tokensCss).toMatch(
      /::-webkit-scrollbar-track,\s*::-webkit-scrollbar-corner \{\s*background: transparent;/
    );
  });

  it("shows the thumb on hover or focus inside, hides it otherwise", () => {
    expect(tokensCss).toMatch(
      /::-webkit-scrollbar-thumb \{\s*background-color: transparent;/
    );
    expect(tokensCss).toMatch(
      /:hover::-webkit-scrollbar-thumb,\s*:focus-within::-webkit-scrollbar-thumb \{\s*background-color: var\(--scrollbar-thumb\);/
    );
  });

  it("serves engines without the pseudo-elements through scrollbar-color", () => {
    const block = /@supports not selector\(::-webkit-scrollbar\)\s*\{([\s\S]*?)\n\}/.exec(
      tokensCss
    )?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/scrollbar-width: thin;/);
    expect(block).toMatch(
      /\*:hover,\s*\*:focus-within \{\s*scrollbar-color: var\(--scrollbar-thumb\) transparent;/
    );
  });

  it("keeps Chromium on the pseudo-elements for the transcript and keeps .no-scrollbar", () => {
    // The registry's `scrollbar-thin` utility would switch Chromium to
    // classic bars; the viewport resets it.
    expect(tokensCss).toMatch(
      /\[data-slot="message-scroller-viewport"\] \{\s*scrollbar-width: auto;\s*scrollbar-color: auto;/
    );
    expect(tokensCss).toMatch(/\.no-scrollbar \{\s*scrollbar-width: none;/);
    expect(tokensCss).toMatch(
      /\.no-scrollbar::-webkit-scrollbar \{\s*display: none;/
    );
  });
});
