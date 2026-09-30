/**
 * The screenshot gate's checks (scripts/screenshots-next.mjs; Codex impl
 * r1 #13, Claude impl r1 #9/#10): each one fails on the geometry or the
 * axe result it guards, so a green run means the states were asserted.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const script = pathToFileURL(
  resolve(import.meta.dirname, "../../../scripts/screenshots-next.mjs")
).href;

type Checks = {
  axeFailures(
    name: string,
    violations: Array<{ id: string; impact: string; nodes: string[] }>
  ): string[];
  panelSplitProblems(name: string, split: unknown): string[];
  floatingProblems(name: string, floating: unknown): string[];
  compactProblems(name: string, compact: unknown): string[];
  fullScreenProblems(name: string, probe: unknown): string[];
};

const load = async (): Promise<Checks> => (await import(script)) as Checks;

describe("screenshot gate checks", () => {
  it("fails on serious and critical axe violations, not on minor ones", async () => {
    const { axeFailures } = await load();
    expect(
      axeFailures("a.png", [
        { id: "aria-required-children", impact: "critical", nodes: ["nav"] },
        { id: "color-contrast", impact: "serious", nodes: ["#x"] },
        { id: "region", impact: "moderate", nodes: ["main"] },
      ])
    ).toHaveLength(2);
  });

  it("asserts the 1100 split: both sides ≥ 360 and an 8 px gutter", async () => {
    const { panelSplitProblems } = await load();
    const ok = {
      pane: { left: 336, right: 704, width: 368 },
      panel: { left: 712, right: 1092, width: 380 },
      innerWidth: 1100,
    };
    expect(panelSplitProblems("s", ok)).toEqual([]);
    expect(
      panelSplitProblems("s", {
        ...ok,
        pane: { ...ok.pane, width: 350, right: 710 },
      })
    ).toHaveLength(2);
    expect(panelSplitProblems("s", { innerWidth: 1100 })).toEqual([
      "s: side panel not in layout",
    ]);
  });

  it("asserts the floating sidebar's place and that the pane did not reflow", async () => {
    const { floatingProblems } = await load();
    const ok = {
      rect: { left: 60, width: 280, top: 44 },
      railW: 56,
      toolbar: 40,
      paneBefore: 64,
      paneAfter: 64,
    };
    expect(floatingProblems("f", ok)).toEqual([]);
    expect(floatingProblems("f", { ...ok, paneAfter: 344 })).toHaveLength(1);
    expect(floatingProblems("f", { ...ok, rect: null })).toHaveLength(1);
  });

  it("asserts compact density and full screen", async () => {
    const { compactProblems, fullScreenProblems } = await load();
    expect(
      compactProblems("c", { toolbar: 32, topbar: 32, rows: [24, 24] })
    ).toEqual([]);
    expect(
      compactProblems("c", { toolbar: 40, topbar: 40, rows: [32] })
    ).toHaveLength(3);
    expect(
      fullScreenProblems("x", {
        fullScreen: true,
        paddingLeft: 0,
        topbar: 40,
        toolbar: 40,
      })
    ).toEqual([]);
    expect(
      fullScreenProblems("x", {
        fullScreen: true,
        paddingLeft: 78,
        topbar: 40,
        toolbar: 40,
      })
    ).toHaveLength(1);
  });
});
