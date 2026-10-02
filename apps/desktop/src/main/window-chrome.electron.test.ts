import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "./services/browser/browser-snapshot-harness";
const availability = harnessAvailability();
const required =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" || !!process.env.CI;
if (required && !availability.usable) throw new Error(availability.reason);
let scratch = "";
let result: any;
describe.skipIf(!availability.usable)(
  "R7-T29: real BaseWindow and RendererHost chrome",
  () => {
    beforeAll(async () => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "chrome-e2e-"));
      const { build } = await import("rolldown");
      await build({
        input: path.join(import.meta.dirname, "window-chrome.e2e-entry.ts"),
        platform: "node",
        external: ["electron", "electron-store"],
        output: { file: path.join(scratch, "main.cjs"), format: "cjs" },
        logLevel: "silent",
      });
      fs.symlinkSync(
        path.resolve(import.meta.dirname, "../../../../node_modules"),
        path.join(scratch, "node_modules"),
        "dir"
      );
      const page = path.join(scratch, "page.html");
      fs.writeFileSync(
        page,
        `<style>body{margin:0}#bar{height:40px;padding-left:env(titlebar-area-x,0px);padding-right:calc(100vw - env(titlebar-area-x,0px) - env(titlebar-area-width,100vw));-webkit-app-region:drag}#popup{position:fixed;left:450px;top:0;width:100px;height:40px;-webkit-app-region:no-drag}</style><div id="bar"></div><script>window.geometryEvents=0;navigator.windowControlsOverlay?.addEventListener('geometrychange',()=>window.geometryEvents++);window.openPopup=kind=>{document.querySelector('#popup')?.remove();let b=document.createElement('button');b.id='popup';b.onclick=()=>{window.lastDismissed=kind;b.remove()};document.body.append(b)};</script>`
      );
      const report = path.join(scratch, "result.json");
      const electron = createRequire(import.meta.url)("electron") as string;
      const args = [
        path.join(scratch, "main.cjs"),
        "--no-sandbox",
        "--disable-gpu",
      ];
      execFileSync(
        availability.wrapper?.command ?? electron,
        availability.wrapper
          ? [...availability.wrapper.args, electron, ...args]
          : args,
        {
          timeout: 45_000,
          env: {
            ...process.env,
            ABACUSAI_BOT_HOME: scratch,
            CHROME_E2E_HOME: scratch,
            CHROME_E2E_RESULT: report,
            CHROME_E2E_PAGE: page,
          },
          stdio: "pipe",
        }
      );
      result = JSON.parse(fs.readFileSync(report, "utf8"));
      expect(result.error).toBeUndefined();
    }, 60_000);
    afterAll(() => {
      if (scratch) fs.rmSync(scratch, { force: true, recursive: true });
    });
    const clearance = (g: any) => {
      expect(g.toolbar).toBe(40);
      expect(g.left).toBeGreaterThanOrEqual(g.x);
      expect(g.right).toBeGreaterThanOrEqual(g.windowWidth - g.x - g.width);
    };
    it("initial API geometry equals CSS reservations and clears native controls", () => {
      expect(result.hasGeometry).toBe(true);
      clearance(result.initial);
    });
    it("resize, maximize and fullscreen preserve toolbar height and restore reservations", () => {
      for (const g of [
        result.resized,
        result.maximized,
        result.fullscreen,
        result.restored,
      ])
        expect(g.toolbar).toBe(40);
      expect(result.resized.windowWidth).not.toBe(result.initial.windowWidth);
      clearance(result.restored);
    });
    it("swap forwards geometry into the new view", () => {
      expect(result.swapped).toBe(true);
      clearance(result.beforeSwap);
      clearance(result.afterSwap);
    });
    it("popup no-drag content over the toolbar accepts native input and dismisses", () => {
      expect(result.popupClicks).toEqual(["popover", "dialog", "bare"]);
    });
    it("browser corners accept input after sidebar movement at zoom 1.25", () => {
      expect(result.browserClicks).toEqual([true, true]);
    });
    it.skipIf(process.platform !== "linux")(
      "missing and full-width geometry recreate native frame with preserved bounds",
      () => {
        expect(result.native.missing).toBe("unavailable");
        expect(result.native.full).toBe("unavailable");
        expect(result.native.bounds).toEqual(result.native.expected);
      }
    );
    it.skipIf(process.platform !== "linux")(
      "failed Linux probe persists the native-frame choice",
      () => {
        expect(result.native.persisted).toBe(true);
      }
    );
  }
);
