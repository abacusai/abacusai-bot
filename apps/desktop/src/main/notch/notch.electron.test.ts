import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildSync } from "esbuild";
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
    buildSync({
      absWorkingDir: desktop,
      entryPoints: ["src/main/notch/window.ts", "src/main/notch/dispose.ts"],
      bundle: true,
      platform: "node",
      external: ["electron"],
      outdir: scratch,
      outExtension: { ".js": ".cjs" },
    });
    buildSync({
      absWorkingDir: desktop,
      entryPoints: ["src/renderer-next/lib/sound.ts"],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "Phase6Audio",
      outfile: join(scratch, "sound.js"),
    });
    const audioScript = readFileSync(join(scratch, "sound.js"), "utf8");
    buildSync({
      absWorkingDir: desktop,
      entryPoints: ["src/renderer-next/test-support/notch-fit.tsx"],
      bundle: true,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      alias: {
        "#next": "./src/renderer-next",
        "#shared": "./src/shared",
        "#locales": "./src/renderer/locales",
      },
      outfile: join(scratch, "fit.js"),
    });
    const fitScript = readFileSync(join(scratch, "fit.js"), "utf8");
    const renderer = join(desktop, "dist/renderer");
    const css = [
      ...[
        readFileSync(join(renderer, "index-next.html"), "utf8"),
        readFileSync(join(renderer, "notch.html"), "utf8"),
      ]
        .join("\n")
        .matchAll(/href="([^"]+\.css)"/g),
    ].map((match) => match[1]);
    const html = `<html class="notch dark"><head>${css.map((file) => `<link rel="stylesheet" href="file://${join(renderer, file!.replace(/^\//, ""))}">`).join("")}</head><body></body></html>`;
    writeFileSync(join(scratch, "fit.html"), html);
    writeFileSync(
      join(scratch, "test.cjs"),
      `const {app,webContents}=require('electron'); const {createNotchWindow,createNotchView}=require('./window.cjs'); const {disposeNotchWindow}=require('./dispose.cjs'); app.setPath('userData',${JSON.stringify(scratch)}); app.on('window-all-closed',()=>{}); app.whenReady().then(async()=>{ const base=webContents.getAllWebContents().length;const samples=[];const viewportSize=async(view,width,height)=>{const deadline=Date.now()+5000;let size;do{size=await view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');if(size.width===width&&size.height===height)return size;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);throw Error('rendered viewport mismatch: '+JSON.stringify({expected:{width,height},actual:size,native:view.getBounds()}));};for(let i=0;i<20;i++){const placement={bounds:{x:0,y:0,width:300,height:100}};const created=createNotchWindow(process.platform,placement,'');const win=created.win;let view=created.view;if(i===1){const old=view;view=createNotchView('');win.contentView.addChildView(view);win.contentView.removeChildView(old);old.webContents.close();}view.webContents.setBackgroundThrottling(false);win.setContentBounds({x:0,y:0,width:560,height:220});await new Promise(r=>setTimeout(r,50));const bounds=view.getBounds();if(bounds.width!==560||bounds.height!==220)throw Error('viewport mismatch');await view.webContents.loadURL('data:text/html,<body></body>');win.showInactive();const viewport=await viewportSize(view,560,220);if(viewport.width!==560||viewport.height!==220)throw Error('rendered viewport mismatch');const grown={...bounds,viewport};win.setContentBounds({x:i%2?40:0,y:i%2?30:0,width:300,height:100});const shrunk=await viewportSize(view,300,100);if(shrunk.width!==300||shrunk.height!==100)throw Error('shrunken viewport mismatch');win.setContentBounds({x:0,y:0,width:560,height:220});await viewportSize(view,560,220);samples.push({grown,shrunk});if(i===0){await view.webContents.executeJavaScript(${JSON.stringify(audioScript)});const energy=await view.webContents.executeJavaScript("(async()=>{const rows=[];for(const cue of Object.keys(Phase6Audio.CUE_TONES)){const ctx=new OfflineAudioContext(1,48000,48000);Phase6Audio.synthCue(ctx,cue,0);const data=(await ctx.startRendering()).getChannelData(0);let first=-1,last=-1,sum=0;for(let i=0;i<data.length;i++){sum+=data[i]*data[i];if(Math.abs(data[i])>0.00001){if(first<0)first=i;last=i;}}rows.push({cue,energy:sum,durationMs:(last-first+1)/48});}return rows})()");console.log('AUDIO_RESULT:'+JSON.stringify(energy));await view.webContents.loadFile(${JSON.stringify(join(scratch, "fit.html"))});await view.webContents.executeJavaScript(${JSON.stringify(fitScript)});win.showInactive();const fit=await view.webContents.executeJavaScript("(async()=>{const rows=[];for(const locale of ['en-US','de-DE','ja-JP']){for(const [type,request] of [['terminal',{type:'run_terminal',command:'git status',cwd:'/work'}],['path',{type:'delete',filePath:'/work/a'}],['url',{type:'fetch_url',url:'https://example.com/a'}],['host',{type:'network_host',host:'example.com',port:443}],['sandbox',{type:'sandbox_denied',command:'git status',denials:[{kind:'read',path:'/work/a'}],note:'Read this file'}]]){rows.push({locale,type,size:'short',...await window.__phase6Fit(request,560,locale)});const long={...request};if(type==='terminal')long.command='long '.repeat(150);if(type==='path')long.filePath='/'+ '長'.repeat(300);if(type==='url')long.url+='x'.repeat(500);if(type==='host')long.host+='x'.repeat(500);if(type==='sandbox')long.note='note '.repeat(150);rows.push({locale,type,size:'long',...await window.__phase6Fit(long,560,locale)});rows.push({locale,type,size:'narrow',...await window.__phase6Fit(request,160,locale)});}const q={type:'ask_user_question',questions:[{header:'Choice',question:'Which?',multiSelect:false,options:[{label:'One',description:'First'},{label:'Two',description:'Second'}]}]};rows.push({locale,type:'question',size:'short',...await window.__phase6Fit(q,560,locale)});q.questions[0].options[0].description='long '.repeat(200);rows.push({locale,type:'question',size:'long',...await window.__phase6Fit(q,560,locale)});}return rows;})()");console.log('FIT_RESULT:'+JSON.stringify(fit));const listening=await view.webContents.executeJavaScript("(async()=>{const rows=[];for(const mode of ['plain','notch','capsule'])for(const locale of ['en-US','de-DE','ja-JP'])rows.push({mode,locale,...await window.__phase6ListeningFit(mode,locale)});return rows})()");console.log('LISTENING_RESULT:'+JSON.stringify(listening));}const entry={win,active:view,standby:null,disposed:false};disposeNotchWindow(entry,()=>{});disposeNotchWindow(entry,()=>{});await new Promise(r=>setTimeout(r,30));}console.log('NOTCH_RESULT:'+JSON.stringify({base,after:webContents.getAllWebContents().length,samples}));app.quit();}).catch(e=>{console.error(e);app.exit(1);});`
    );
    const output = await new Promise<string>((yes, no) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(
        require("electron"),
        [
          join(scratch, "test.cjs"),
          "--no-sandbox",
          "--disable-renderer-backgrounding",
          "--disable-backgrounding-occluded-windows",
          "--disable-background-timer-throttling",
        ],
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
      }, 60000);
      child.on("error", no);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) yes(out);
        else no(new Error(`Electron exit ${code}: ${out}`));
      });
    });
    const listeningLine = output
      .split("\n")
      .find((line) => line.startsWith("LISTENING_RESULT:"));
    expect(listeningLine, output).toBeTruthy();
    const listening = JSON.parse(
      listeningLine!.slice("LISTENING_RESULT:".length)
    );
    expect(listening).toHaveLength(9);
    for (const row of listening) {
      expect(row.controls).toBe(2);
      expect(row.visible, JSON.stringify(row)).toBe(true);
    }
    const line = output
      .split("\n")
      .find((line) => line.startsWith("NOTCH_RESULT:"));
    expect(line, output).toBeTruthy();
    const result = JSON.parse(line!.slice("NOTCH_RESULT:".length));
    expect(result.after).toBe(result.base);
    expect(result.samples).toHaveLength(20);
    const audioLine = output
      .split("\n")
      .find((line) => line.startsWith("AUDIO_RESULT:"));
    expect(audioLine, output).toBeTruthy();
    const audio = JSON.parse(audioLine!.slice("AUDIO_RESULT:".length)) as {
      cue: string;
      energy: number;
      durationMs: number;
    }[];
    const bounds: Record<string, [number, number]> = {
      sent: [60, 120],
      received: [120, 220],
      "needs-you": [200, 320],
      done: [180, 280],
      failed: [150, 250],
      "routine-fired": [120, 200],
    };
    expect(audio).toHaveLength(6);
    for (const row of audio) {
      expect(row.energy).toBeGreaterThan(0);
      expect(row.durationMs).toBeGreaterThanOrEqual(bounds[row.cue]![0]);
      expect(row.durationMs).toBeLessThanOrEqual(bounds[row.cue]![1]);
    }
    result.audio = audio;
    const fitLine = output
      .split("\n")
      .find((line) => line.startsWith("FIT_RESULT:"));
    expect(fitLine, output).toBeTruthy();
    const fit = JSON.parse(fitLine!.slice("FIT_RESULT:".length)) as {
      locale: string;
      type: string;
      size: string;
      accept: boolean;
      buttons: string[];
      font: string;
      visibleOverflow: boolean;
    }[];
    expect(fit).toHaveLength(51);
    for (const row of fit) {
      if (row.type !== "question" && row.size === "short")
        expect(row.accept, JSON.stringify(row)).toBe(true);
      if (row.size === "long")
        expect(row.accept, JSON.stringify(row)).toBe(false);
      if (row.type === "question") {
        expect(row.buttons.includes("OneFirst"), JSON.stringify(row)).toBe(
          row.size === "short"
        );
      }
      if (row.accept || row.buttons.includes("OneFirst"))
        expect(row.visibleOverflow, JSON.stringify(row)).toBe(false);
      expect(row.font).toContain("Inter");
    }
    result.fit = fit;
    mkdirSync(join(desktop, "../../.build/phase6"), { recursive: true });
    writeFileSync(
      join(desktop, "../../.build/phase6/native-result.json"),
      JSON.stringify(result, null, 2)
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90000);
