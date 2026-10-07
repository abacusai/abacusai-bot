/**
 * The shell's geometry and surfaces (Claude impl r1 #18, visual V1–V3, V5):
 * one set of numbers in geometry.ts, mirrored by tokens.css, all on the
 * 8 px grid; the chrome see-through only where main puts vibrancy/mica.
 */
import { describe, expect, it } from "vitest";

import { GEOMETRY_VARS, SHELL_GEOMETRY } from "./geometry";
import {
  clampPanelWidth,
  PANE_MIN_PX,
  PANEL_DEFAULT_PX,
  PANEL_MAX_PX,
  PANEL_MIN_PX,
  panelMaxFor,
} from "./side-panel";

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

  it("steps the columns: composer < content < wide content, all wider than the pane minimum", () => {
    const g = SHELL_GEOMETRY;
    expect(g.composerMaxW).toBeLessThan(g.contentMaxW);
    expect(g.contentMaxW).toBeLessThan(g.contentMaxWWide);
    expect(g.composerMaxW).toBeGreaterThan(g.sidePanelMin);
  });

  it("declares the content column classes on the tokens", () => {
    expect(tokensCss).toContain("--page-gutter: 24px;");
    expect(tokensCss).toMatch(
      /@media \(width < 800px\)[\s\S]*?--page-gutter: 16px;/
    );
    expect(tokensCss).toMatch(
      /\.content-col \{\s*width: min\(var\(--content-max-w\), 100% - 2 \* var\(--page-gutter\)\);/
    );
    expect(tokensCss).toMatch(
      /\.content-col-wide \{\s*width: min\(var\(--content-max-w-wide\), 100% - 2 \* var\(--page-gutter\)\);/
    );
  });

  it("clamps the side panel between its min and max, the drawer and default inside", () => {
    const g = SHELL_GEOMETRY;
    expect([PANEL_MIN_PX, PANEL_MAX_PX]).toEqual([
      g.sidePanelMin,
      g.sidePanelMax,
    ]);
    expect(g.sidePanelMin).toBeLessThan(g.sidePanelMax);
    expect(PANEL_DEFAULT_PX).toBeGreaterThanOrEqual(PANEL_MIN_PX);
    expect(PANEL_DEFAULT_PX).toBeLessThanOrEqual(PANEL_MAX_PX);
    expect(g.sidePanelDrawerW).toBeLessThanOrEqual(g.sidePanelMax);
    expect(clampPanelWidth(100)).toBe(PANEL_MIN_PX);
    expect(clampPanelWidth(420)).toBe(420);
    expect(clampPanelWidth(1200)).toBe(PANEL_MAX_PX);
    expect(clampPanelWidth(900, 480)).toBe(480);
  });

  it("lets the panel take up to 60 % of the split or 960 px, the pane keeping its minimum", () => {
    const g = SHELL_GEOMETRY;
    expect(g.sidePanelMax).toBe(960);
    // Unmeasured: the absolute cap.
    expect(panelMaxFor(Number.POSITIVE_INFINITY)).toBe(PANEL_MAX_PX);
    // 1100 window: 748 px split → 60 % would be 448, but the pane keeps its
    // 360 and the gutter, so 380.
    expect(panelMaxFor(748)).toBe(380);
    expect(748 - panelMaxFor(748) - g.paneInset).toBeGreaterThanOrEqual(
      PANE_MIN_PX
    );
    // 1600 wide split: 60 % is 960, the cap.
    expect(panelMaxFor(1600)).toBe(960);
    expect(panelMaxFor(2400)).toBe(960);
    // Too narrow for both: never under the panel's own minimum.
    expect(panelMaxFor(500)).toBe(PANEL_MIN_PX);
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
    // The whole document chain, so the body's opaque background cannot hide
    // the material, and the chrome itself paints nothing over it.
    expect(block).toMatch(/\[data-titlebar="overlay"\][^{]*\) body,/);
    expect(block).toMatch(/\[data-titlebar="overlay"\][^{]*\) #root \{/);
    expect(block).toMatch(
      /\.shell-surface \{\s*background-color: transparent;/
    );
    // The layers over it: the pane and the in-layout panel keep nine tenths
    // of their colour; the floating sidebar tints the native material.
    expect(block).toMatch(
      /\[data-slot="pane"\], \[data-slot="side-panel"\]\[data-mode="layout"\]\) \{\s*background-color: color-mix\(in oklab, var\(--background\) 90%, transparent\);/
    );
    expect(block).toMatch(
      /\[data-slot="sidebar-floating"\] \{\s*background-color: color-mix\(in oklab, var\(--sidebar\) \d+%, transparent\);/
    );
    expect(block).not.toContain("backdrop-filter");
    expect(tokensCss).toContain('data-window-focused="false"');
    // Outside that rule the chrome is opaque.
    expect(tokensCss).toMatch(
      /\.shell-surface \{\s*background-color: var\(--sidebar\);/
    );
  });

  it("gives the pane and the in-layout panel a visible edge in light (V2)", () => {
    expect(tokensCss).toMatch(
      /\[data-slot="pane"\],\s*\[data-slot="side-panel"\]\[data-mode="layout"\],\s*\.workspace-island \{\s*\/\*[^*]*\*\/\s*outline: 1px solid var\(--border\);\s*outline-offset: -1px;/
    );
  });

  it("separates pane and panel with an 8 px gutter (V3)", () => {
    expect(tokensCss).toMatch(
      /\[data-pane-gutter\] \{[^}]*width: max\(8px, var\(--pane-inset\)\);/
    );
  });
});
