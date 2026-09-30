/**
 * The shell's geometry and surfaces (Claude impl r1 #18, visual V1–V3, V5):
 * one set of numbers in geometry.ts, mirrored by tokens.css, all on the
 * 8 px grid; the chrome see-through only where main puts vibrancy/mica.
 */
import { describe, expect, it } from "vitest";

import { GEOMETRY_VARS, SHELL_GEOMETRY } from "./geometry";

import tokensCss from "../../styles/tokens.css?raw";

const rootValue = (name: string): number | null => {
  const root = /:root\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? "";
  const match = new RegExp(`${name}:\\s*(\\d+)px`).exec(root);
  return match == null ? null : Number(match[1]);
};

describe("shell geometry", () => {
  it("tokens.css declares every value geometry.ts holds, equal", () => {
    for (const [key, name] of Object.entries(GEOMETRY_VARS))
      expect([name, rootValue(name)]).toEqual([
        name,
        SHELL_GEOMETRY[key as keyof typeof SHELL_GEOMETRY],
      ]);
  });

  it("sits on the 8 px grid, apart from the canvas's 356 px drawer and 12 px radius", () => {
    for (const [key, value] of Object.entries(SHELL_GEOMETRY)) {
      if (key === "sidePanelDrawerW" || key === "paneRadius") continue;
      expect([key, value % 8]).toEqual([key, 0]);
    }
  });

  it("leaves the pane and the panel their 360 px each at the 1100 minimum", () => {
    const g = SHELL_GEOMETRY;
    const room = 1100 - g.railW - g.sidebarW - g.paneInset - g.paneInset;
    expect(room).toBe(748);
    expect(room).toBeGreaterThanOrEqual(2 * g.sidePanelMin);
  });
});

describe("shell surfaces", () => {
  it("makes the document and the chrome see-through only for vibrancy/mica overlay windows, never under reduced transparency (V1)", () => {
    const block =
      /@media not \(prefers-reduced-transparency: reduce\)\s*\{([\s\S]*?)\n\}/.exec(
        tokensCss
      )?.[1];
    expect(block).toBeDefined();
    expect(block).toContain(
      'html:is([data-platform="darwin"], [data-platform="win32"])[data-titlebar="overlay"]'
    );
    expect(block).toMatch(/background-color: transparent/);
    expect(block).toMatch(
      /\.shell-surface[\s\S]*color-mix\(in oklab, var\(--sidebar\)/
    );
    // Outside that rule the chrome is opaque.
    expect(tokensCss).toMatch(
      /\.shell-surface \{\s*background-color: var\(--sidebar\);/
    );
  });

  it("gives the pane and the in-layout panel a visible edge in light (V2)", () => {
    expect(tokensCss).toMatch(
      /\[data-slot="pane"\],\s*\[data-slot="side-panel"\]\[data-mode="layout"\] \{\s*\/\*[^*]*\*\/\s*outline: 1px solid var\(--border\);\s*outline-offset: -1px;/
    );
  });

  it("separates pane and panel with an 8 px gutter (V3)", () => {
    expect(tokensCss).toMatch(
      /\[data-pane-gutter\] \{[^}]*width: var\(--pane-inset\);/
    );
  });
});
