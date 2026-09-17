/**
 * What the terminal does to the viewport while output arrives, run in a real
 * browser against the real WASM parser.
 *
 * ghostty-web 0.4.0 ends every write with `viewportY !== 0 &&
 * this.scrollToBottom()`: output snaps the view to the bottom precisely when
 * the user has scrolled up, which is the inverse of what a terminal does and
 * what "terminal upward scrolling isn't in great shape" was. The library never
 * implemented scrollback anchoring; the snap stood in for it. patches/
 * ghostty-web@0.4.0.patch replaces it with the anchor, and this is the test
 * that says the patch is still there and still works.
 *
 * jsdom cannot answer any of this: there is no canvas to open the terminal on
 * and the grid never gets a cell size, so the harness the browser-snapshot
 * tests already use is borrowed here — which is why a test about renderer
 * code sits with the other whole-app checks in `src/main` rather than beside
 * the panel: it is a node test that spawns Electron, and renderer sources may
 * not reach into main. The bundle inlines its own WASM as a
 * data: URL, so the fixture is one self-contained page with no server.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  harnessAvailability,
  runSnapshotFixtures,
} from "./services/browser/browser-snapshot-harness";

/**
 * The ESM bundle as a classic script: its single trailing `export { a as b }`
 * becomes an assignment to a global, which leaves a file with no module syntax
 * in it. Importing it instead would need a module script, and a module script
 * on a `file://` page is blocked before it runs.
 */
const bundleAsGlobal = (): string => {
  // `import.meta.resolve`, because the package exports only its bare
  // specifier, and only under the "import" condition does that name the ESM
  // build — which is the one the app loads and the one the patch touches.
  const source = readFileSync(
    fileURLToPath(import.meta.resolve("ghostty-web")),
    "utf8"
  );
  const match = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(source);

  if (match == null) {
    throw new Error("ghostty-web's bundle no longer ends in an export block");
  }

  const members = match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [local, exported] = entry.split(/\s+as\s+/);
      return `${JSON.stringify((exported ?? local)!.trim())}: ${local!.trim()}`;
    });

  return `${source.slice(0, match.index)}\nwindow.__ghostty = { ${members.join(", ")} };\n`;
};

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: #000; }
  #host { width: 800px; height: 400px; }
</style></head>
<body><div id="host"></div>
<script>${bundleAsGlobal()}</script>
</body></html>`;

/**
 * 200 lines of history, scroll up 30, then write 20 more. Anchored means the
 * viewport moves back by exactly the number of lines that entered the
 * scrollback, so the same text stays under the user's eyes.
 */
const SCRIPT = `(async () => {
  const { init, Terminal } = window.__ghostty;
  await init();
  const term = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 1000,
    convertEol: false,
    smoothScrollDuration: 0,
  });
  term.open(document.getElementById("host"));
  for (let i = 1; i <= 200; i += 1) term.write("line " + i + "\\r\\n");

  const atBottom = term.getViewportY();
  term.scrollLines(-30);
  const scrolledBack = term.getViewportY();
  for (let i = 201; i <= 220; i += 1) term.write("line " + i + "\\r\\n");
  const afterOutput = term.getViewportY();

  term.scrollToBottom();
  const backAtBottom = term.getViewportY();
  for (let i = 221; i <= 230; i += 1) term.write("line " + i + "\\r\\n");
  const following = term.getViewportY();

  term.dispose();

  return { atBottom, scrolledBack, afterOutput, backAtBottom, following };
})()`;

/**
 * The other half of the report: "can we support normal scrolling without
 * clicking on side scrollbar". A wheel event over the grid, then one over a
 * full-screen app, which must send arrow keys instead of moving the viewport.
 */
const WHEEL_SCRIPT = `(async () => {
  const { init, Terminal } = window.__ghostty;
  await init();
  const host = document.getElementById("host");
  const term = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 1000,
    convertEol: false,
    smoothScrollDuration: 0,
  });
  term.open(host);
  for (let i = 1; i <= 200; i += 1) term.write("line " + i + "\\r\\n");

  const wheel = (deltaY) =>
    host.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      })
    );

  wheel(-100);
  const afterWheelUp = term.getViewportY();
  wheel(40);
  const afterWheelDown = term.getViewportY();

  // An alternate-screen app (vim, less, htop) gets arrow keys, not a viewport
  // move: its own scrollback is the application's business.
  const sent = [];
  term.onData((data) => sent.push(data));
  term.write("\\x1B[?1049h");
  const before = term.getViewportY();
  wheel(-100);

  term.dispose();

  return {
    afterWheelUp,
    afterWheelDown,
    alternateScreenViewport: term.getViewportY?.() ?? before,
    sentOnAlternateScreen: sent.join(""),
  };
})()`;

/**
 * Dragging a selection past the top edge has to keep scrolling and keep
 * extending the selection — the "selection-based scroll" in the report.
 */
const SELECTION_SCRIPT = `(async () => {
  const { init, Terminal } = window.__ghostty;
  await init();
  const host = document.getElementById("host");
  const term = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 1000,
    convertEol: false,
    smoothScrollDuration: 0,
  });
  term.open(host);
  for (let i = 1; i <= 200; i += 1) term.write("line " + i + "\\r\\n");

  const canvas = host.querySelector("canvas");
  const rect = canvas.getBoundingClientRect();
  const at = (type, x, y, target) =>
    (target ?? canvas).dispatchEvent(
      new MouseEvent(type, {
        clientX: rect.left + x,
        clientY: rect.top + y,
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    );

  at("mousedown", 40, rect.height - 40);
  at("mousemove", 40, 40);
  const beforeAutoScroll = term.getViewportY();
  // Off the top of the grid: the drag continues outside the canvas.
  at("mouseleave", 40, -20);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterAutoScroll = term.getViewportY();
  const selected = term.getSelection();
  at("mouseup", 40, -20, document);

  term.dispose();

  return { beforeAutoScroll, afterAutoScroll, selectedLength: selected.length };
})()`;

/**
 * The grid stopped short of its container: the canvas is sized to
 * `cols * cellWidth`, while `proposeDimensions` reserves 15px for a scrollbar
 * the renderer then draws *inside* that canvas. So the panel had a dead strip
 * down its right edge and a scrollbar floating well left of it. The patch
 * stretches the canvas to the container and leaves the reservation to keep the
 * last column clear of the scrollbar lane.
 */
const LAYOUT_SCRIPT = `(async () => {
  const { init, Terminal, FitAddon } = window.__ghostty;
  await init();
  const host = document.getElementById("host");
  const term = new Terminal({
    cols: 80,
    rows: 24,
    convertEol: false,
    smoothScrollDuration: 0,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  const canvas = host.querySelector("canvas");
  const cols = term.cols;
  const widthAfterFit = Math.round(Number.parseFloat(canvas.style.width));

  // A few frames of output: a canvas whose width no longer matches
  // cols * cellWidth used to be resized on every one of them.
  for (let i = 0; i < 5; i += 1) {
    term.write("line " + i + "\\r\\n");
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
  }

  const renderer = term.renderer;
  const metrics = renderer.getMetrics();
  const report = {
    hostWidth: host.clientWidth,
    widthAfterFit,
    widthAfterFrames: Math.round(Number.parseFloat(canvas.style.width)),
    colsAfterFrames: cols === term.cols ? cols : -1,
    // What the renderer itself thinks, so a failure on a machine I cannot
    // reach says why rather than only that.
    renderer: {
      patched: String(renderer.resize).includes("targetWidth"),
      parentIsHost: canvas.parentElement === host,
      gridWidth: renderer.gridWidth ?? null,
      gridCols: renderer.gridCols ?? null,
      target: renderer.targetWidth ? renderer.targetWidth(term.cols) : null,
      cellWidth: metrics.width,
      cols: term.cols,
      devicePixelRatio: window.devicePixelRatio,
    },
  };

  term.dispose();

  return report;
})()`;

interface ViewportReport {
  atBottom: number;
  scrolledBack: number;
  afterOutput: number;
  backAtBottom: number;
  following: number;
}

interface LayoutReport {
  hostWidth: number;
  /** Reported for diagnosis: whether the first sizing already had a container. */
  widthAfterFit: number;
  widthAfterFrames: number;
  colsAfterFrames: number;
  renderer: Record<string, unknown>;
}

interface SelectionReport {
  beforeAutoScroll: number;
  afterAutoScroll: number;
  selectedLength: number;
}

interface WheelReport {
  afterWheelUp: number;
  afterWheelDown: number;
  sentOnAlternateScreen: string;
}

const availability = harnessAvailability();

describe.skipIf(!availability.usable)(
  "the terminal viewport while output arrives",
  () => {
    it("holds its place in the scrollback, and still follows from the bottom", () => {
      const report = runSnapshotFixtures(SCRIPT, {
        scrollback: FIXTURE,
      }).scrollback as unknown as ViewportReport;

      // Sanity: a fresh terminal sits at the bottom, and scrolling up moves
      // exactly as far as it was asked to.
      expect(report.atBottom).toBe(0);
      expect(report.scrolledBack).toBe(30);

      // The patch: 20 lines of output pushed 20 lines into the scrollback, so
      // the viewport is 20 further from the bottom and the reader has not
      // moved. Unpatched, this is 0 — the snap.
      expect(report.afterOutput).toBe(50);

      // And the other half of the rule: at the bottom, output still follows.
      expect(report.backAtBottom).toBe(0);
      expect(report.following).toBe(0);
    });

    it("fills the width it was given, and keeps filling it", () => {
      const layout = runSnapshotFixtures(LAYOUT_SCRIPT, {
        layout: FIXTURE,
      }).layout as unknown as LayoutReport;

      // The host is 800px wide in the fixture; the grid covers all of it.
      expect(layout.hostWidth).toBe(800);
      // Asserted after a frame rather than at the instant of the first
      // sizing: whether the canvas has a laid-out container to measure by
      // then is the browser's business, and it cost a CI failure to learn
      // that it differs between platforms. What the patch owes is that the
      // renderer corrects itself and then holds, which is this.
      expect(
        layout.widthAfterFrames,
        `renderer said ${JSON.stringify(layout.renderer)}`
      ).toBe(800);
      expect(layout.colsAfterFrames).toBeGreaterThan(0);
    });

    it("keeps scrolling while a selection is dragged off the top", () => {
      const drag = runSnapshotFixtures(SELECTION_SCRIPT, {
        selection: FIXTURE,
      }).selection as unknown as SelectionReport;

      expect(drag.beforeAutoScroll).toBe(0);
      expect(drag.afterAutoScroll).toBeGreaterThan(0);
      // The selection grew with the scroll rather than staying where the
      // pointer left the grid.
      expect(drag.selectedLength).toBeGreaterThan(0);
    });

    it("scrolls on the wheel, and leaves a full-screen app its own keys", () => {
      const wheel = runSnapshotFixtures(WHEEL_SCRIPT, {
        wheel: FIXTURE,
      }).wheel as unknown as WheelReport;

      // Up the history and back down again, with nothing but the wheel.
      expect(wheel.afterWheelUp).toBeGreaterThan(0);
      expect(wheel.afterWheelDown).toBeLessThan(wheel.afterWheelUp);

      // On the alternate screen the wheel is arrow keys, so `less` and `vim`
      // move their own cursor instead of the terminal's viewport.
      const cursorUp = "\u001b[A";
      expect(wheel.sentOnAlternateScreen.length).toBeGreaterThan(0);
      expect(wheel.sentOnAlternateScreen.replaceAll(cursorUp, "")).toBe("");
    });
  }
);
