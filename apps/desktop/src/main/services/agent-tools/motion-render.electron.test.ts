/**
 * The motion renderer in a real Electron: plan → page → frames → H.264 → MP4,
 * through the real preload encoder. Checks the file itself (box structure,
 * frame count, frame size, duration), not just that something was written.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { harnessAvailability } from "../browser/browser-snapshot-harness";

const availability = harnessAvailability();
const required =
  process.env.ABACUSBOT_REQUIRE_ELECTRON_SUITES === "1" || !!process.env.CI;
if (required && !availability.usable) throw new Error(availability.reason);

const desktop = path.resolve(import.meta.dirname, "../../../..");

/** The boxes of an MP4 that say what is in it: enough to prove it plays. */
type Mp4Facts = {
  boxes: string[];
  avc?: number;
  width?: number;
  height?: number;
  samples?: number;
  duration?: number;
  timescale?: number;
};

const inspectMp4 = (file: string): Mp4Facts => {
  const data = fs.readFileSync(file);
  const boxes: string[] = [];
  const found: Record<string, number> = {};
  const walk = (start: number, end: number): void => {
    let at = start;
    while (at + 8 <= end) {
      const size = data.readUInt32BE(at);
      const type = data.toString("latin1", at + 4, at + 8);
      if (size < 8 || at + size > end) break;
      boxes.push(type);
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type))
        walk(at + 8, at + size);
      if (type === "mvhd") {
        found.timescale = data.readUInt32BE(at + 20);
        found.duration = data.readUInt32BE(at + 24);
      }
      if (type === "tkhd") {
        found.width = data.readUInt32BE(at + 84) >> 16;
        found.height = data.readUInt32BE(at + 88) >> 16;
      }
      if (type === "stsz") found.samples = data.readUInt32BE(at + 16);
      if (type === "avcC") found.avc = 1;
      at += size;
    }
  };
  walk(0, data.length);
  // avcC sits inside stsd's sample entry, which the walk does not descend.
  if (data.includes(Buffer.from("avcC"))) found.avc = 1;
  return { boxes, ...found };
};

const PLANS = [
  {
    template: "title-card",
    size: "16:9",
    slots: { title: "Quarterly results", subtitle: "Up 42% on last year" },
    name: "title",
  },
  // Played fast: the page on a scaled clock.
  {
    template: "kinetic-text",
    size: "9:16",
    slots: { lines: ["Stop guessing.", "Start measuring."] },
    name: "reel",
    pace: "fast",
  },
  // In software: the second attempt after a hardware encoder fails.
  {
    template: "animated-chart",
    size: "1:1",
    slots: {
      title: "Signups",
      bars: [
        { label: "Mon", value: 120 },
        { label: "Tue", value: 340 },
      ],
    },
    name: "chart",
    software: true,
  },
  // The user's logo, read from disk by the host by a relative path.
  {
    template: "logo-reveal",
    size: "1:1",
    slots: { logo: "logo.png", name: "Northwind" },
    name: "logo",
  },
];

let scratch = "";
let results: Array<Record<string, any>> = [];

describe.skipIf(!availability.usable)("motion render in Electron", () => {
  beforeAll(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "motion-e2e-"));
    const { build } = await import("rolldown");
    await build({
      input: path.join(import.meta.dirname, "motion-render.e2e-entry.ts"),
      platform: "node",
      external: ["electron"],
      resolve: { alias: { "#main": path.join(desktop, "src/main") } },
      output: { file: path.join(scratch, "main.cjs"), format: "cjs" },
      logLevel: "silent",
    });
    // The encoder and mp4-muxer in one file. The app's own build is checked
    // for the same (nothing but electron required) in packaged-startup.test.ts.
    await build({
      input: path.join(desktop, "src/preload/index.ts"),
      platform: "node",
      external: ["electron"],
      output: { file: path.join(scratch, "preload.cjs"), format: "cjs" },
      logLevel: "silent",
    });
    // A 2×2 PNG, dark: the logo the logo reveal reads by a relative path.
    fs.writeFileSync(
      path.join(scratch, "logo.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGNgYGD4z8DAwMDAwMAAAP8ABQAB0fEj+QAAAABJRU5ErkJggg==",
        "base64"
      )
    );
    const out = path.join(scratch, "out");
    fs.writeFileSync(
      path.join(scratch, "plans.json"),
      JSON.stringify(
        PLANS.map((plan) => ({
          ...plan,
          outputDir: out,
          cwd: scratch,
        }))
      )
    );
    const report = path.join(scratch, "result.json");
    const electron = createRequire(import.meta.url)("electron") as string;
    const args = [
      path.join(scratch, "main.cjs"),
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ];
    execFileSync(
      availability.wrapper?.command ?? electron,
      availability.wrapper
        ? [...availability.wrapper.args, electron, ...args]
        : args,
      {
        timeout: 170_000,
        env: {
          ...process.env,
          ABACUSAI_BOT_RESOURCES: path.join(desktop, "resources"),
          MOTION_E2E_PLANS: path.join(scratch, "plans.json"),
          MOTION_E2E_PRELOAD: path.join(scratch, "preload.cjs"),
          MOTION_E2E_RESULT: report,
        },
        stdio: "pipe",
      }
    );
    results = JSON.parse(fs.readFileSync(report, "utf8"));
  }, 200_000);

  afterAll(() => {
    if (scratch) fs.rmSync(scratch, { force: true, recursive: true });
  });

  it.each([
    [0, 1920, 1080],
    [1, 1080, 1920],
    [2, 1080, 1080],
    [3, 1080, 1080],
  ])(
    "plan %i renders a playable H.264 MP4 at %ix%i, and only the MP4 lands in the folder",
    (index, width, height) => {
      const result = results[index]!;
      expect(result.error).toBeUndefined();
      const mp4 = inspectMp4(result.videoPath);
      expect(mp4.boxes.slice(0, 1)).toEqual(["ftyp"]);
      expect(mp4.boxes).toContain("moov");
      expect(mp4.avc).toBe(1);
      expect([mp4.width, mp4.height]).toEqual([width, height]);
      expect(mp4.samples).toBe(result.frames);
      expect(result.frames).toBe(Math.ceil(result.seconds * 30));
      expect(mp4.duration! / mp4.timescale!).toBeCloseTo(result.seconds, 0);
      expect(path.extname(result.videoPath)).toBe(".mp4");
      expect(
        fs
          .readdirSync(path.join(scratch, "out"))
          .every((f) => f.endsWith(".mp4"))
      ).toBe(true);
    }
  );
});
