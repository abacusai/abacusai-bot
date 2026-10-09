import { writeFileSync } from "node:fs";

/**
 * The chat kit's Electron gates over the bench fixtures (spec 02 §13):
 *
 * - R2-T16, Electron half: the loader waits on `session.load()` (one promise
 *   for concurrent callers) with a 2 s hydrate and with a 2 s `joinRun` on a
 *   thread whose only run is active; the view commits with the echo and the
 *   streamed text in the transcript, the viewport carries
 *   `data-pending-scroll` when it is inserted, and the first visible frame
 *   shows the transcript end. Prepending a page keeps the first visible
 *   message at its offset (±1 px). The mounted-row window: away from the end,
 *   "Show earlier" and a 3,000-tool message's step expansion keep mounted
 *   rows ≤ MAX_ROWS and the first fully visible row at its offset (±1 px).
 * - R2-T31, the performance gate (a)-(e). The numbers are printed as a
 *   `[R2-T31]` JSON line for the record; each threshold is asserted.
 *
 * The bench (`features/chat/fixtures/perf/bench.tsx`) mounts a real
 * `ChatView` over a `FakeRelay` holding a synthetic thread, as a route does.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launch, readiness, REQUIRED, stats, type App } from "./electron-app";

const PORT = 9394;
/** spec 02 §10 `MAX_ROWS`. */
const MAX_ROWS = 100;
const ready = readiness();

let app: App;
const numbers: Record<string, unknown> = {};

/** Mounts a bench fixture and waits until its first visible frame painted. */
const open = async (fixture: string): Promise<void> => {
  await app.evaluate(`(async () => {
    window.__chatBench = undefined;
    location.hash = "#/__ui";
    await new Promise((r) => setTimeout(r, 150));
    location.hash = ${JSON.stringify(`#/__ui?fixture=${fixture}`)};
  })()`);
  await app.until(
    `window.__chatBench?.id === ${JSON.stringify(fixture)} && window.__chatBench.firstPaintMs != null`,
    30_000,
    `${fixture} painted`
  );
};

const bench = <T>(expression: string): Promise<T> =>
  app.evaluate<T>(
    `(async () => { const b = window.__chatBench; ${expression} })()`
  );

const rows = () =>
  bench<{ messages: number; tools: number; subagents: number; total: number }>(
    "return b.rows();"
  );

/** Page helpers: the viewport, rows, the anchor row and its offset. */
const HELPERS = `(() => {
  if (window.__chatHelpers) return;
  const viewport = () => document.querySelector('[data-slot="message-scroller-viewport"]');
  const ROW = '[data-slot="message-scroller-item"], [data-tool], [data-slot="subagent-row"]';
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const task = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
  window.__chatHelpers = {
    viewport,
    frame,
    task,
    /** The first row fully inside the viewport, and its offset from the top. */
    anchor() {
      const box = viewport().getBoundingClientRect();
      const candidates = [...viewport().querySelectorAll(ROW)]
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && rect.top >= box.top && rect.bottom <= box.bottom)
        .sort((a, b) => a.rect.top - b.rect.top);
      const first = candidates[0];
      if (first == null) return null;
      window.__chatAnchor = first.el;
      return { offset: first.rect.top - box.top, text: (first.el.textContent || "").slice(0, 60) };
    },
    /** Where the last anchor is now, or null when it was unmounted. */
    anchorOffset() {
      const el = window.__chatAnchor;
      if (el == null || !el.isConnected) return null;
      return el.getBoundingClientRect().top - viewport().getBoundingClientRect().top;
    },
    async settle() { await frame(); await frame(); await task(); },
    /** Clicks, then the time until the resulting work (render, commit, layout effects) is done. */
    async timedClick(el) {
      const t0 = performance.now();
      el.click();
      await task();
      return performance.now() - t0;
    },
  };
})()`;

beforeAll(async () => {
  if (!ready.runnable) return;
  ready.prepare();
  // Benchmark rendering without waiting for the hosted runner's display swap.
  // Chromium's frame-rate limit and the 50 fps gate remain enabled.
  app = await launch({ port: PORT, args: ["--disable-gpu-vsync"] });
  app.on("Runtime.exceptionThrown", (p) =>
    console.error("CHAT_RENDER_ERROR", JSON.stringify(p).slice(0, 3000))
  );
  app.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error")
      console.error("CHAT_CONSOLE", JSON.stringify(p.args).slice(0, 3000));
  });
  app.harness("window.focus", {});
  await app.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-reduced-transparency", value: "no-preference" },
    ],
  });
  await app.evaluate(HELPERS);
}, 600_000);

afterAll(async () => {
  await app?.close();
  if (Object.keys(numbers).length > 0) {
    console.info(`[R2-T31] ${JSON.stringify(numbers)}`);
    if (process.env.ABACUSBOT_CHAT_METRICS_FILE)
      writeFileSync(
        process.env.ABACUSBOT_CHAT_METRICS_FILE,
        JSON.stringify(numbers, null, 2) + "\n"
      );
  }
});

if (!ready.runnable && REQUIRED)
  describe("chat kit gates (Electron)", () => {
    it("has what it needs to run", () => {
      throw new Error(
        `required (CI / ABACUSBOT_REQUIRE_ELECTRON_SUITES) but cannot run: ${ready.skipReason}`
      );
    });
  });

type Frame = {
  t: number;
  viewport: boolean;
  pending: boolean;
  lastInView: boolean;
  text?: string;
};

const loaderCase = async (fixture: string) => {
  await open(fixture);
  const result = await bench<{
    samePromise: boolean;
    loadMs: number;
    insertedPending: boolean | null;
    frames: Frame[];
  }>(
    "return { samePromise: b.samePromise, loadMs: b.loadMs, insertedPending: b.insertedPending, frames: b.frames };"
  );
  expect(result.samePromise, "two load() callers share one promise").toBe(true);
  // The loader waited on the slow call.
  expect(result.loadMs).toBeGreaterThanOrEqual(1900);
  expect(result.insertedPending, "data-pending-scroll at insertion").toBe(true);
  const visible = result.frames.find((f) => f.viewport && !f.pending);
  expect(visible, "a visible frame").toBeDefined();
  // The first visible frame already has the echo and the streamed text, and
  // shows the transcript end.
  expect(visible!.text).toContain("Echoed before the loader committed");
  expect(visible!.text).toContain("And the second sentence arrived too.");
  expect(visible!.lastInView).toBe(true);
  // No frame ever showed the viewport before its opening position.
  for (const frame of result.frames.filter((f) => f.viewport && !f.pending))
    expect(frame.lastInView).toBe(true);
};

describe.skipIf(!ready.runnable)("chat kit gates (Electron)", () => {
  describe("R2-T16 (Electron)", () => {
    it("a 2 s hydrate: the loader commits with the active run's echo and streamed text, at the end, pending-scroll first", async () => {
      await loaderCase("bench-slow-hydrate");
    });

    it("a 2 s joinRun on a thread whose only run is active: the same", async () => {
      await loaderCase("bench-slow-join");
    });

    it("prepending a page keeps the first visible message at its offset (±1 px)", async () => {
      await open("bench-rich");
      const drifts: number[] = [];
      for (let page = 0; page < 3; page += 1) {
        const before = await bench<number>(
          "return b.session.hostStore.state.messages.length;"
        );
        await app.evaluate(`(async () => {
          const v = window.__chatHelpers.viewport();
          v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          const row = v.querySelector("[data-message-id]");
          const start = row.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop;
          v.scrollTop = Math.min(start + 600, v.scrollHeight - v.clientHeight - 100);
          await window.__chatHelpers.settle();
        })()`);
        const anchor = await app.evaluate<{ offset: number } | null>(
          "window.__chatHelpers.anchor()"
        );
        expect(anchor).not.toBeNull();
        await bench("await b.session.loadOlder();");
        await app.until(
          `window.__chatBench.session.hostStore.state.messages.length > ${before}`,
          10_000,
          "an older page"
        );
        await app.evaluate("window.__chatHelpers.settle()");
        const after = await app.evaluate<number | null>(
          "window.__chatHelpers.anchorOffset()"
        );
        expect(after, "the anchor row stays mounted").not.toBeNull();
        drifts.push(Math.abs(after! - anchor!.offset));
      }
      numbers.prependDriftPx = drifts;
      for (const drift of drifts) expect(drift).toBeLessThanOrEqual(1);
    });
  });

  describe("R2-T31 (gate)", () => {
    it("(a) 1,000 messages, rich Markdown, 1,500 tool rows, 5 sub-agents: first paint < 600 ms, scroll ≥ 50 fps median, rows ≤ MAX_ROWS", async () => {
      await open("bench-rich");
      const firstPaint = await bench<number>("return b.firstPaintMs;");
      numbers.a_firstPaintMs = Math.round(firstPaint);
      expect(firstPaint).toBeLessThan(600);
      // Page the whole thread in while reading away from the end.
      await app.evaluate(`(async () => {
        const v = window.__chatHelpers.viewport();
        v.dispatchEvent(new WheelEvent("wheel", {deltaY: -100, bubbles: true}));
        v.scrollTop = Math.max(0, v.scrollHeight - v.clientHeight - 200);
        await window.__chatHelpers.settle();
      })()`);
      for (let i = 0; i < 40; i += 1) {
        const more = await bench<boolean>(
          "await b.session.loadOlder(); return b.session.hostStore.state.hasOlderMessages;"
        );
        await app.evaluate("window.__chatHelpers.settle()");
        if (!more) break;
      }
      numbers.a_messages = await bench<number>(
        "return b.session.hostStore.state.messages.length;"
      );
      const mounted = await rows();
      numbers.a_rows = mounted;
      expect(mounted.total).toBeLessThanOrEqual(MAX_ROWS);
      const intervals = await app.evaluate<number[]>(`(async () => {
        const v = window.__chatHelpers.viewport();
        v.scrollTop = v.scrollHeight;
        await window.__chatHelpers.settle();
        const out = [];
        let last = null;
        let direction = -1;
        const end = performance.now() + 3000;
        await new Promise((resolve) => {
          const step = (now) => {
            if (last != null) out.push(now - last);
            last = now;
            v.scrollTop += direction * 60;
            if (v.scrollTop <= 0) direction = 1;
            if (v.scrollTop + v.clientHeight >= v.scrollHeight) direction = -1;
            if (now < end) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
        return out;
      })()`);
      const fps = 1000 / stats(intervals).median;
      numbers.a_scrollFpsMedian = Math.round(fps * 10) / 10;
      numbers.a_scrollFrameP95Ms = Math.round(stats(intervals).p95 * 10) / 10;
      // Measure the runner's idle frame pacing after the scroll measurement,
      // so this diagnostic cannot warm up or change the performance gate.
      const idleIntervals = await app.evaluate<number[]>(`(async () => {
        await window.__chatHelpers.settle();
        const out = [];
        let last = null;
        const end = performance.now() + 500;
        await new Promise((resolve) => {
          const step = (now) => {
            if (last != null) out.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(step); else resolve();
          };
          requestAnimationFrame(step);
        });
        return out;
      })()`);
      numbers.a_idleFpsMedian =
        Math.round((1000 / stats(idleIntervals).median) * 10) / 10;
      expect(fps).toBeGreaterThanOrEqual(50);
      expect((await rows()).total).toBeLessThanOrEqual(MAX_ROWS);
    });

    it("(b) a replayed active run of 800 events → 350 messages: readiness < 800 ms, rows ≤ MAX_ROWS", async () => {
      await open("bench-replay");
      const loadMs = await bench<number>("return b.loadMs;");
      const messages = await bench<number>(
        "return b.session.hostStore.state.messages.length;"
      );
      numbers.b_readinessMs = Math.round(loadMs);
      numbers.b_messages = messages;
      expect(messages).toBe(350);
      expect(loadMs).toBeLessThan(800);
      const mounted = await rows();
      numbers.b_rows = mounted;
      expect(mounted.total).toBeLessThanOrEqual(MAX_ROWS);
    });

    it("(c) one message with 3,000 tool calls: first paint < 400 ms", async () => {
      await open("bench-tools");
      const firstPaint = await bench<number>("return b.firstPaintMs;");
      numbers.c_firstPaintMs = Math.round(firstPaint);
      numbers.c_rows = await rows();
      expect(firstPaint).toBeLessThan(400);
      expect((numbers.c_rows as { total: number }).total).toBeLessThanOrEqual(
        MAX_ROWS
      );
    });

    it("(d) streaming 20 KB of Markdown: main-thread tasks < 50 ms at p95", async () => {
      await open("bench-stream");
      const events: Array<{
        name: string;
        ph: string;
        dur?: number;
        tid: number;
        pid: number;
        args?: { name?: string };
      }> = [];
      const off = app.on("Tracing.dataCollected", (params) =>
        events.push(...params.value)
      );
      const complete = new Promise<void>((resolve) => {
        const stop = app.on("Tracing.tracingComplete", () => {
          stop();
          resolve();
        });
      });
      await app.send("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
          includedCategories: [
            "disabled-by-default-devtools.timeline",
            "devtools.timeline",
            "toplevel",
            "__metadata",
          ],
        },
      });
      const deltas = await bench<number>(
        "return await b.stream({ intervalMs: 16, bytes: 20 * 1024 });"
      );
      await app.evaluate("window.__chatHelpers.settle()");
      await app.send("Tracing.end");
      await complete;
      off();
      // The renderer's main thread: the page process's CrRendererMain.
      const main = events.find(
        (e) => e.name === "thread_name" && e.args?.name === "CrRendererMain"
      );
      const tasks = events
        .filter(
          (e) =>
            e.ph === "X" &&
            e.name === "RunTask" &&
            main != null &&
            e.pid === main.pid &&
            e.tid === main.tid &&
            e.dur != null
        )
        .map((e) => e.dur! / 1000);
      const all = stats(tasks);
      // Tasks that did work (≥ 1 ms): the per-chunk parse and render.
      const busy = stats(tasks.filter((ms) => ms >= 1));
      numbers.d_deltas = deltas;
      numbers.d_tasks = tasks.length;
      numbers.d_taskP95Ms = Math.round(all.p95 * 100) / 100;
      numbers.d_busyTaskP95Ms = Math.round(busy.p95 * 100) / 100;
      numbers.d_taskMaxMs = Math.round(all.max * 100) / 100;
      numbers.d_longTasks = tasks.filter((ms) => ms >= 50).length;
      expect(tasks.length).toBeGreaterThan(deltas);
      expect(all.p95).toBeLessThan(50);
      expect(busy.p95).toBeLessThan(50);
    });
  });

  describe("R2-T16 window (Electron) and R2-T31(e)", () => {
    /**
     * Activates `find()`'s control 20 times, away from the end: after each,
     * mounted rows ≤ MAX_ROWS, the first fully visible row keeps its offset
     * (±1 px), and the activation's commit took < 50 ms.
     */
    const activate = async (find: string, label: string) => {
      const commits: number[] = [];
      const drifts: number[] = [];
      let peak = 0;
      for (let i = 0; i < 20; i += 1) {
        const found = await app.evaluate<boolean>(`(() => {
          const el = (${find})();
          if (el == null) return false;
          const v = window.__chatHelpers.viewport();
          // Keep this manual-control benchmark outside the automatic pager's
          // 400px margin, with the anchor on the side the action retains.
          const content = v.querySelector('[data-slot="message-scroller-content"]').getBoundingClientRect();
          const box = v.getBoundingClientRect();
          const top = !/earlier/i.test(el.textContent || "")
            ? content.bottom - box.top + v.scrollTop - v.clientHeight - 100
            : content.top - box.top + v.scrollTop + 500;
          v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          v.scrollTop = Math.max(0, Math.min(v.scrollHeight - v.clientHeight - 100, top));
          return true;
        })()`);
        if (!found) break;
        await app.evaluate("window.__chatHelpers.settle()");
        const anchor = await app.evaluate<{ offset: number } | null>(
          "window.__chatHelpers.anchor()"
        );
        const ms = await app.evaluate<number>(
          `window.__chatHelpers.timedClick((${find})())`
        );
        await app.evaluate("window.__chatHelpers.settle()");
        commits.push(ms);
        const after = await app.evaluate<number | null>(
          "window.__chatHelpers.anchorOffset()"
        );
        if (anchor != null) {
          expect(
            after,
            `${label} ${i}: the anchor stays mounted`
          ).not.toBeNull();
          drifts.push(Math.abs(after! - anchor.offset));
        }
        const mounted = (await rows()).total;
        peak = Math.max(peak, mounted);
        expect(mounted, `${label} ${i}: mounted rows`).toBeLessThanOrEqual(
          MAX_ROWS
        );
      }
      numbers[`e_${label}`] = {
        activations: commits.length,
        commitMs: stats(commits),
        maxDriftPx: Math.max(0, ...drifts),
        peakRows: peak,
      };
      expect(commits.length, `${label}: activations`).toBe(20);
      for (const drift of drifts) expect(drift).toBeLessThanOrEqual(1);
      for (const ms of commits) expect(ms).toBeLessThan(50);
    };

    it('history: "Show earlier" 20 times away from the end', async () => {
      await open("bench-rich");
      await app.evaluate(`(async () => {
        const v = window.__chatHelpers.viewport();
        v.dispatchEvent(new WheelEvent("wheel", {deltaY: -100, bubbles: true}));
        v.scrollTop = Math.max(0, v.scrollHeight - v.clientHeight - 200);
        await window.__chatHelpers.settle();
      })()`);
      for (let i = 0; i < 40; i += 1) {
        const more = await bench<boolean>(
          "await b.session.loadOlder(); return b.session.hostStore.state.hasOlderMessages;"
        );
        if (!more) break;
      }
      await app.evaluate("window.__chatHelpers.settle()");
      await activate(
        `() => [...document.querySelectorAll('[data-slot="window-placeholder"]')].find((el) => /earlier|later/i.test(el.textContent || ""))`,
        "history"
      );
    });

    it("tools: a 3,000-tool message's steps expanded 20 times", async () => {
      await open("bench-tools");
      await activate(
        `() => [...document.querySelectorAll('[data-slot="window-placeholder"], [data-slot="steps-more"], button')].find((el) => /more steps|earlier steps/i.test(el.textContent || ""))`,
        "tools"
      );
    });

    it("automatic history paging keeps the visible anchor without a button click", async () => {
      await open("bench-rich");
      await app.evaluate(`(async () => {
        const v = window.__chatHelpers.viewport();
        v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
        v.scrollTop = Math.max(0, v.scrollHeight - v.clientHeight - 200);
        await window.__chatHelpers.settle();
      })()`);
      for (let page = 0; page < 40; page += 1) {
        const more = await bench<boolean>(
          "await b.session.loadOlder(); return b.session.hostStore.state.hasOlderMessages;"
        );
        if (!more) break;
      }
      await app.evaluate("window.__chatHelpers.settle()");
      for (let page = 0; page < 20; page += 1) {
        const before = await app.evaluate<{
          first: string;
          anchor: { offset: number } | null;
        }>(`(() => {
          const v = window.__chatHelpers.viewport();
          const content = v.querySelector('[data-slot="message-scroller-content"]');
          const first = v.querySelector('[data-message-id]').dataset.messageId;
          v.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
          v.scrollTop = content.getBoundingClientRect().top - v.getBoundingClientRect().top + v.scrollTop + 16;
          return { first, anchor: window.__chatHelpers.anchor() };
        })()`);
        expect(
          before.anchor,
          `automatic page ${page}: a visible row`
        ).not.toBeNull();
        await app.until(
          `window.__chatHelpers.viewport().querySelector('[data-message-id]').dataset.messageId !== ${JSON.stringify(before.first)}`,
          5_000,
          "automatic history expansion"
        );
        await app.evaluate(`(async () => {
          for (let frame = 0; frame < 20; frame += 1)
            await window.__chatHelpers.frame();
        })()`);
        const after = await app.evaluate<number | null>(
          "window.__chatHelpers.anchorOffset()"
        );
        expect(
          after,
          `automatic page ${page}: anchor stays mounted`
        ).not.toBeNull();
        expect(Math.abs(after! - before.anchor!.offset)).toBeLessThanOrEqual(1);
        expect((await rows()).total).toBeLessThanOrEqual(MAX_ROWS);
      }
    });
  });
});

describe.skipIf(!ready.runnable)(
  "transcript density and composer inset",
  () => {
    it.each([
      { transparency: "no-preference", padding: 96, gap: 80 },
      { transparency: "reduce", padding: 16, gap: 16 },
    ])(
      "measures tool density and composer padding with transparency $transparency",
      async ({ transparency, padding, gap }) => {
        await app.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-transparency", value: transparency },
          ],
        });
        await open("bench-stream");
        await bench(`
      const messages = Array.from({ length: 20 }, (_, i) => ({
        id: 'density-' + i, role: 'assistant', parts: [
          { type: 'text', content: '  ' },
          { type: 'tool-call', id: 'call-' + i, name: 'bash', state: 'complete',
            arguments: '{}', input: { command: 'npm test -- ' + i }, output: { text: 'ok' } }
        ]
      }));
      messages.unshift({ id: 'density-intro', role: 'assistant', parts: [{ type: 'text', content: 'Checking the example.' }] });
      messages.push({ id: 'density-final', role: 'assistant', parts: [{ type: 'text', content: 'All example checks are complete.' }] });
      b.session.hostStore.setState(s => ({ ...s, messages }));
    `);
        await app.until(
          'document.querySelectorAll("[data-tool]").length === 20'
        );
        await app.evaluate("window.__chatHelpers.settle()");
        const density = await app.evaluate<{
          heights: number[];
          pitch: number[];
          actions: number;
          position: string;
          opacity: string;
          hostHeight: number;
          textHeight: number;
        }>(`(() => {
      const rows = [...document.querySelectorAll('[data-tool]')].map(e => e.getBoundingClientRect());
      const host = document.querySelector('[data-message-id="density-final"] [data-slot="message-actions-host"]');
      const action = host.querySelector('[data-slot="session-message-actions"]');
      return {
        heights: rows.map(r => r.height), pitch: rows.slice(1).map((r, i) => r.top - rows[i].top),
        actions: document.querySelectorAll('[data-tool-only] [data-slot="message-actions-host"]').length,
        position: getComputedStyle(action).position, opacity: getComputedStyle(action).opacity,
        hostHeight: host.getBoundingClientRect().height, textHeight: host.firstElementChild.getBoundingClientRect().height
      };
    })()`);
        for (const height of density.heights) expect(height).toBeCloseTo(28, 0);
        for (const pitch of density.pitch) expect(pitch).toBeCloseTo(30, 0);
        expect(density.actions).toBe(0);
        expect(density.position).toBe("absolute");
        expect(density.opacity).toBe("0");
        expect(density.hostHeight).toBe(density.textHeight);
        expect(
          await app.evaluate<string>(`(() => {
      const action = document.querySelector('[data-message-id="density-final"] [data-slot="session-message-actions"]');
      action.querySelector('button').focus();
      return getComputedStyle(action).opacity;
    })()`)
        ).toBe("1");
        const initial = await app.evaluate<number>(
          `document.querySelector('[data-slot="composer-dock"]').getBoundingClientRect().height`
        );
        await app.evaluate(`(() => {
      const input = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Review the example.\\nCheck accessibility.\\nSummarize the results.\\nInclude any failed checks.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const store = window.__chatBench.session.hostStore.state.store;
      store.setState(s => ({ ...s, queue: [{ id: 'example-queue', message: 'Write a short report', waitingFor: 'turn' }] }));
    })()`);
        await app.until(
          `document.querySelector('[data-slot="composer-dock"]').getBoundingClientRect().height > ${initial + 20}`
        );
        await app.until(`(() => {
      const v = window.__chatHelpers.viewport(), d = document.querySelector('[data-slot="composer-dock"]');
      return Math.abs(parseFloat(getComputedStyle(v).getPropertyValue('--transcript-bottom-inset')) - d.getBoundingClientRect().height) < 1;
    })()`);
        await app.evaluate(`(async () => {
      const v = window.__chatHelpers.viewport(); v.scrollTop = v.scrollHeight;
      await window.__chatHelpers.settle();
    })()`);
        const inset = await app.evaluate<{
          padding: number;
          height: number;
          gap: number;
          mask: string;
        }>(`(() => {
      const v = window.__chatHelpers.viewport(), d = document.querySelector('[data-slot="composer-dock"]').getBoundingClientRect();
      return {
        padding: parseFloat(getComputedStyle(document.querySelector('[data-slot="message-scroller-content"]')).paddingBottom),
        height: d.height, gap: d.top - document.querySelector('[data-message-id="density-final"]').getBoundingClientRect().bottom,
        mask: getComputedStyle(v).maskImage
      };
    })()`);
        expect(inset.padding - inset.height).toBeCloseTo(padding, 0);
        expect(inset.gap).toBeGreaterThanOrEqual(gap);
        expect(inset.mask).not.toBe("none");
      }
    );
  }
);
