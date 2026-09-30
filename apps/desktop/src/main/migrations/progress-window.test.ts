/**
 * C-T6: the progress window is not created when the runner finishes within
 * 400 ms; otherwise it is created, updated (at most 10 times a second) and
 * closed, with Electron mocked.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { windows, FakeWindow } = vi.hoisted(() => {
  const windows: InstanceType<typeof FakeWindow>[] = [];

  class FakeWindow {
    options: Record<string, unknown>;
    destroyed = false;
    visible = false;
    url = "";
    scripts: string[] = [];
    listeners = new Map<string, () => void>();
    webContents = {
      executeJavaScript: vi.fn(async (script: string) => {
        this.scripts.push(script);
      }),
    };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      windows.push(this);
    }
    once(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
    }
    isDestroyed() {
      return this.destroyed;
    }
    emit(event: string) {
      this.listeners.get(event)?.();
    }
  }

  return { windows, FakeWindow };
});

vi.mock("electron", () => ({ BrowserWindow: FakeWindow }));

import {
  createMigrationProgress,
  openProgressWindow,
  progressPage,
  type MigrationProgress,
} from "./progress-window";
import { runMigrations } from "./runner";

const open = () =>
  openProgressWindow({
    appName: "AbacusAI Bot",
    dark: true,
    backgroundColor: "#0a0a0a",
  });

beforeEach(() => {
  windows.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("C-T6 progress window", () => {
  it("is never created when the runner finishes in under 400 ms", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "progress-"));
    const progress = createMigrationProgress({ open });
    try {
      await runMigrations({
        home,
        userData: home,
        appVersion: "1",
        steps: [
          {
            id: 1,
            name: "quick",
            plan: async () => ({ writes: [], removals: [], stats: {} }),
          },
        ],
        onProgress: (done, total, label) => progress.report(done, total, label),
        log: () => undefined,
      });
      await vi.advanceTimersByTimeAsync(399);
      progress.finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(windows).toHaveLength(0);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  describe("a slow run", () => {
    let progress: MigrationProgress;

    beforeEach(async () => {
      progress = createMigrationProgress({ open });
      progress.report(0, 10, "prefs-from-renderer-state");
      await vi.advanceTimersByTimeAsync(400);
    });

    it("opens a locked-down, frameless window on a self-contained page", () => {
      expect(windows).toHaveLength(1);
      const [window] = windows;
      expect(window?.options).toMatchObject({
        width: 420,
        height: 140,
        frame: false,
        resizable: false,
        show: false,
        backgroundColor: "#0a0a0a",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      expect(window?.url.startsWith("data:text/html;charset=utf-8,")).toBe(
        true
      );
      const page = decodeURIComponent(
        window?.url.split(",").slice(1).join(",") ?? ""
      );
      expect(page).not.toMatch(/(src|href)=["']?https?:/);
      expect(page).toContain("window.setProgress");
      expect(window?.visible).toBe(false);
    });

    it("shows on ready-to-show with the latest progress, throttled to 10/s", async () => {
      const [window] = windows;
      if (window == null) throw new Error("no window");
      window.emit("ready-to-show");
      expect(window.visible).toBe(true);
      expect(window.scripts).toEqual([
        'window.setProgress(0,10,"prefs-from-renderer-state")',
      ]);

      for (let done = 1; done <= 9; done += 1)
        progress.report(done, 10, "step");
      expect(window.scripts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(window.scripts).toEqual([
        'window.setProgress(0,10,"prefs-from-renderer-state")',
        'window.setProgress(9,10,"step")',
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      progress.report(10, 10, "done");
      expect(window.scripts.at(-1)).toBe('window.setProgress(10,10,"done")');
    });

    it("closes when the runner resolves and is freed once the main window exists", async () => {
      const [window] = windows;
      if (window == null) throw new Error("no window");
      window.emit("ready-to-show");
      progress.finish();
      expect(window.visible).toBe(false);
      // Not destroyed yet: it may be the only window.
      expect(window.destroyed).toBe(false);
      progress.report(5, 10, "late");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(window.scripts).toHaveLength(1);

      progress.dispose();
      expect(window.destroyed).toBe(true);
    });

    it("never shows when ready-to-show comes after the close", () => {
      const [window] = windows;
      if (window == null) throw new Error("no window");
      progress.finish();
      window.emit("ready-to-show");
      expect(window.visible).toBe(false);
    });
  });

  it("escapes the app name into the page", () => {
    expect(progressPage({ appName: "<b>x</b>", dark: false })).toContain(
      "&lt;b&gt;x&lt;/b&gt;"
    );
  });
});
