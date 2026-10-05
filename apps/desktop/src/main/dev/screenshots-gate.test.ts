/**
 * The screenshot gate's checks (scripts/screenshots.mjs; Codex impl
 * r1 #13, Claude impl r1 #9/#10): each one fails on the geometry or the
 * axe result it guards, so a green run means the states were asserted.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const script = pathToFileURL(
  resolve(import.meta.dirname, "../../../scripts/screenshots.mjs")
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
  collapsedProblems(name: string, collapsed: unknown): string[];
  nativeFrameProblems(name: string, probe: unknown): string[];
  nativeFrameStatus(
    platform: string,
    required: boolean
  ): { run: boolean; record?: string; failures?: string[] };
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

  it("asserts the floating sidebar's place and that the pane kept its left edge and width", async () => {
    const { floatingProblems } = await load();
    const ok = {
      rect: { left: 60, width: 280, top: 44 },
      railW: 56,
      toolbar: 40,
      stable: true,
      paneBefore: { left: 56, width: 1216 },
      paneAfter: { left: 56, width: 1216 },
    };
    expect(floatingProblems("f", ok)).toEqual([]);
    expect(
      floatingProblems("f", { ...ok, paneAfter: { left: 336, width: 1216 } })
    ).toHaveLength(1);
    // Same left edge, narrower: a width reflow fails too (Codex impl r2 #6).
    expect(
      floatingProblems("f", { ...ok, paneAfter: { left: 56, width: 936 } })
    ).toEqual(["f: the pane reflowed (width 1216 → 936)"]);
    expect(floatingProblems("f", { ...ok, stable: false })).toEqual([
      "f: the floating sidebar never held still",
    ]);
    expect(floatingProblems("f", { ...ok, paneAfter: null })).toHaveLength(1);
    expect(floatingProblems("f", { ...ok, rect: null })).toHaveLength(1);
  });

  it("asserts the collapsed state: settled, a 0 px column, the pane against the rail (Codex impl r2 #6)", async () => {
    const { collapsedProblems } = await load();
    const ok = {
      floating: true,
      stable: true,
      slot: { left: 56, width: 0 },
      pane: { left: 56, width: 1216 },
      rail: { right: 56 },
      occupied: "0px",
      pinnedPane: { left: 336, width: 936 },
    };
    expect(collapsedProblems("c", ok)).toEqual([]);
    // A wait that timed out fails instead of capturing whatever was there.
    expect(collapsedProblems("c", { ...ok, floating: false })).toHaveLength(1);
    expect(collapsedProblems("c", { ...ok, stable: false })).toEqual([
      "c: sidebar and pane never held still",
    ]);
    // Mid-spring: the column still 140 px wide, the pane not at the rail.
    expect(
      collapsedProblems("c", {
        ...ok,
        slot: { left: 56, width: 140 },
        pane: { left: 196, width: 1076 },
      })
    ).toHaveLength(2);
    expect(
      collapsedProblems("c", { ...ok, pane: { left: 56, width: 936 } })
    ).toHaveLength(1);
    expect(collapsedProblems("c", { ...ok, occupied: "280px" })).toHaveLength(
      1
    );
    expect(collapsedProblems("c", { ...ok, slot: null })).toHaveLength(1);
  });

  it("keeps the pane fixed when the pinned preference already floats in the md band", async () => {
    const { collapsedProblems } = await load();
    const pane = { left: 56, width: 836 };
    const ok = {
      floating: true,
      stable: true,
      slot: { left: 56, width: 0 },
      pane,
      rail: { right: 56 },
      occupied: "0px",
      pinnedPane: pane,
      pinnedMode: "floating",
    };
    expect(collapsedProblems("c", ok)).toEqual([]);
    expect(
      collapsedProblems("c", { ...ok, pane: { ...pane, width: 840 } })
    ).toHaveLength(1);
    expect(
      collapsedProblems("c", { ...ok, pane: { ...pane, left: 60 } })
    ).toHaveLength(2);
    // A supported pinned column still has to release space on collapse.
    expect(
      collapsedProblems("c", { ...ok, pinnedMode: "pinned" })
    ).toHaveLength(1);
  });

  it("runs the native-frame probe on Linux, and records a skip elsewhere that fails when required (Codex impl r2 #5)", async () => {
    const { nativeFrameStatus } = await load();
    expect(nativeFrameStatus("linux", true)).toEqual({ run: true });
    expect(nativeFrameStatus("linux", false)).toEqual({ run: true });
    expect(nativeFrameStatus("darwin", false)).toEqual({
      run: false,
      record: "skipped: not linux",
      failures: [],
    });
    expect(nativeFrameStatus("darwin", true).failures).toEqual([
      "native-frame: required but skipped: not linux (darwin)",
    ]);
  });

  it("asserts the native-frame chrome: the mode, zero reservations, the bar whole at the top", async () => {
    const { nativeFrameProblems } = await load();
    const ok = {
      titlebar: "native-frame",
      overlayVisible: false,
      titlebarX: 0,
      titlebarEnd: 0,
      paddingLeft: 0,
      topbar: { top: 0, height: 40, width: 1280 },
      toolbar: 40,
      innerWidth: 1280,
      width: 1280,
      band: "xl",
    };
    expect(nativeFrameProblems("n", ok)).toEqual([]);
    expect(nativeFrameProblems("n", { ...ok, titlebar: "overlay" })).toEqual([
      "n: data-titlebar overlay (want native-frame)",
    ]);
    expect(
      nativeFrameProblems("n", {
        ...ok,
        overlayVisible: true,
        titlebarEnd: 138,
        paddingLeft: 70,
      })
    ).toHaveLength(3);
    expect(
      nativeFrameProblems("n", {
        ...ok,
        topbar: { top: 0, height: 0, width: 1280 },
      })
    ).toHaveLength(1);
    expect(
      nativeFrameProblems("n", { ...ok, innerWidth: 1264, band: "lg" })
    ).toHaveLength(3);
    expect(nativeFrameProblems("n", null)).toHaveLength(1);
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
