import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, it } from "vitest";

import { harnessAvailability } from "../services/browser/browser-snapshot-harness";
const required =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" || !!process.env.CI;
const availability = harnessAvailability();
it("R6-T25/T30/T42 native child viewport and disposal cycles", async () => {
  if (!availability.usable) {
    if (required)
      throw new Error(`Electron display unavailable: ${availability.reason}`);
    throw new Error(
      "This native test requires a display; run main-serial on a display host."
    );
  }
  const desktop = resolve(import.meta.dirname, "../../..");
  const require = createRequire(import.meta.url);
  const scratch = mkdtempSync(join(tmpdir(), "abacus-notch-native-"));
  try {
    const esbuild = require.resolve("esbuild/bin/esbuild");
    execFileSync(
      esbuild,
      [
        "src/main/notch/window.ts",
        "src/main/notch/dispose.ts",
        "--bundle",
        "--platform=node",
        "--external:electron",
        `--outdir=${scratch}`,
        "--out-extension:.js=.cjs",
      ],
      { cwd: desktop, stdio: "pipe" }
    );
    writeFileSync(
      join(scratch, "test.cjs"),
      `const {app,webContents}=require('electron'); const {createNotchWindow,fitView}=require('./window.cjs'); const {disposeNotchWindow}=require('./dispose.cjs'); app.setPath('userData',${JSON.stringify(scratch)}); app.on('window-all-closed',()=>{}); app.whenReady().then(async()=>{ const base=webContents.getAllWebContents().length;const samples=[];for(let i=0;i<5;i++){const placement={bounds:{x:0,y:0,width:300,height:100}};const {win,view}=createNotchWindow(process.platform,placement,'');win.setContentBounds({x:0,y:0,width:560,height:220});fitView(win,view);const bounds=view.getBounds();if(bounds.width!==560||bounds.height!==220)throw Error('viewport mismatch');samples.push(bounds);const entry={win,active:view,standby:null,disposed:false};disposeNotchWindow(entry,()=>{});disposeNotchWindow(entry,()=>{});await new Promise(r=>setTimeout(r,30));}console.log('NOTCH_RESULT:'+JSON.stringify({base,after:webContents.getAllWebContents().length,samples}));app.quit();}).catch(e=>{console.error(e);app.exit(1);});`
    );
    const output = await new Promise<string>((yes, no) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        require("electron"),
        [join(scratch, "test.cjs"), "--no-sandbox"],
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.stderr.on("data", (chunk) => {
        out += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        no(new Error(`Electron deadline: ${out}`));
      }, 15000);
      child.on("error", no);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) yes(out);
        else no(new Error(`Electron exit ${code}: ${out}`));
      });
    });
    const line = output
      .split("\n")
      .find((line) => line.startsWith("NOTCH_RESULT:"));
    expect(line, output).toBeTruthy();
    const result = JSON.parse(line!.slice("NOTCH_RESULT:".length));
    expect(result.after).toBe(result.base);
    expect(result.samples).toHaveLength(5);
    mkdirSync(join(desktop, "../../.build/phase6"), { recursive: true });
    writeFileSync(
      join(desktop, "../../.build/phase6/native-result.json"),
      JSON.stringify(result, null, 2)
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30000);
