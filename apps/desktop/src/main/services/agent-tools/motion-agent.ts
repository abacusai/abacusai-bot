/**
 * The motion component, Electron half: a filled template in, an MP4 out.
 *
 * motion-plan.ts validates the plan and fills the template; this writes the
 * page, opens it in a hidden offscreen window, and steps through it: every CSS
 * animation is paused and set to the frame's time, the frame is captured and
 * its pixels go to the window's preload (preload/motion-encoder.ts), which
 * encodes H.264 with Chromium's own encoder and muxes the MP4. No ffmpeg, no
 * downloaded browser: the same code on Windows, macOS and Linux.
 *
 * Offscreen, so the frame is never limited by the screen: a 1080×1920 Reel
 * renders on a 1366×768 laptop. Seeking, so the video is exact: a slow
 * machine takes longer but makes the same frames.
 */
import fs from "fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "path";

import { BrowserWindow, nativeImage, type NativeImage } from "electron";

import { resourcePath } from "#main/resources";

import {
  BUNDLED_FAMILY,
  MOTION_FPS,
  buildMotion,
  type BuiltMotion,
  type MotionFontFaces,
  type MotionImage,
  type MotionRequest,
} from "./motion-plan";

export type RenderMotionRequest = MotionRequest & {
  outputDir: string;
  /** Where a relative image path is from: the agent's workspace. */
  cwd?: string;
  /** The file name without extension; derived from the title when absent. */
  name?: string;
};

export type MotionResult = {
  videoPath: string;
  template: string;
  size: string;
  width: number;
  height: number;
  seconds: number;
  frames: number;
  warnings: string[];
};

/** Extra window size beyond the frame; see where the window is created. */
const WINDOW_MARGIN = 16;

/** How long one step may take before the render is called stuck. */
const STEP_TIMEOUT_MS = 30_000;

/** How a render failure starts, as opposed to a plan the model can fix. */
const RENDER_FAILED = "This computer could not render the video";

const motionDir = (): string => resourcePath("motion");

const readTemplate = (name: string): string =>
  readFileSync(path.join(motionDir(), "templates", `${name}.html`), "utf8");

/**
 * The PDF component's fonts (OFL, latin subset; resources/pdf/fonts), embedded
 * in the page so a video looks the same on Windows, macOS and Linux. Read once.
 */
const FONT_FILES: Record<keyof MotionFontFaces, Array<[number, string]>> = {
  sans: [
    [400, "inter-latin-400-normal.woff2"],
    [600, "inter-latin-600-normal.woff2"],
    [700, "inter-latin-700-normal.woff2"],
  ],
  serif: [
    [400, "source-serif-4-latin-400-normal.woff2"],
    [600, "source-serif-4-latin-600-normal.woff2"],
  ],
  mono: [[400, "jetbrains-mono-latin-400-normal.woff2"]],
};

let faces: MotionFontFaces | null = null;

const fontFaces = (): MotionFontFaces => {
  if (faces != null) return faces;
  const read = (kind: keyof MotionFontFaces): string => {
    try {
      return FONT_FILES[kind]
        .map(
          ([weight, file]) =>
            `@font-face{font-family:${BUNDLED_FAMILY[kind]};font-weight:${weight};font-style:normal;` +
            `src:url(data:font/woff2;base64,${readFileSync(path.join(resourcePath("pdf"), "fonts", file)).toString("base64")}) format('woff2')}`
        )
        .join("\n");
    } catch {
      // Missing fonts cost the look, not the video: the system's are used.
      return "";
    }
  };
  faces = { sans: read("sans"), serif: read("serif"), mono: read("mono") };
  return faces;
};

/** An image's pixels, BGRA, as Electron decodes them; null when it cannot. */
type DecodeImage = (
  bytes: Buffer
) => { width: number; height: number; bgra: Buffer } | null;

const decodeWithElectron: DecodeImage = (bytes) => {
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  return { width, height, bgra: image.toBitmap() };
};

const IMAGE_TYPES: Array<[string, (bytes: Buffer) => boolean]> = [
  [
    "image/png",
    (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  ],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b.subarray(0, 4).toString("latin1") === "GIF8"],
  [
    "image/webp",
    (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  ],
  [
    "image/svg+xml",
    (b) => /<svg[\s>]/i.test(b.subarray(0, 4096).toString("utf8")),
  ],
];

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * An image the plan names (a logo), for the page: read, checked to be an
 * image, embedded as a data: URI, and judged mostly dark or light so a dark
 * logo can sit on a light plate instead of vanishing on a dark background.
 * Errors are for the model, which passes them on.
 */
export const readMotionImage = (
  file: string,
  options: { cwd: string; decode?: DecodeImage }
): MotionImage => {
  const full = path.resolve(options.cwd, file);
  let bytes: Buffer;
  try {
    bytes = readFileSync(full);
  } catch {
    throw new Error(`There is no file at ${full}.`);
  }
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error(
      `${path.basename(full)} is ${Math.round(bytes.length / 1024 / 1024)} MB; use an image under 8 MB.`
    );
  const type = IMAGE_TYPES.find(([, test]) => test(bytes))?.[0];
  if (type == null)
    throw new Error(
      `${path.basename(full)} is not a PNG, JPEG, WebP, GIF or SVG image.`
    );

  let tone: MotionImage["tone"] = "dark";
  const pixels = (options.decode ?? decodeWithElectron)(bytes);
  if (pixels != null) {
    let sum = 0;
    let count = 0;
    const step = Math.max(
      1,
      Math.floor((pixels.width * pixels.height) / 20_000)
    );
    for (let i = 0; i < pixels.width * pixels.height; i += step) {
      const at = i * 4;
      if (pixels.bgra[at + 3]! < 128) continue;
      sum +=
        (0.0722 * pixels.bgra[at]! +
          0.7152 * pixels.bgra[at + 1]! +
          0.2126 * pixels.bgra[at + 2]!) /
        255;
      count++;
    }
    tone = count > 0 && sum / count >= 0.55 ? "light" : "dark";
  }
  return { src: `data:${type};base64,${bytes.toString("base64")}`, tone };
};

/** The plan, validated and filled. Throws with a message meant for the model. */
const planMotion = (
  request: MotionRequest & { cwd?: string; outputDir?: string }
): BuiltMotion =>
  buildMotion(
    request,
    readTemplate,
    readFileSync(path.join(motionDir(), "motion.css"), "utf8"),
    fontFaces(),
    (file) =>
      readMotionImage(file, {
        cwd: request.cwd ?? request.outputDir ?? process.cwd(),
      })
  );

const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** Names Windows will not create a file under, whatever the extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** The file name for a video: a slug of `name`, else the template's. */
export const fileBase = (name: string, template: string): string => {
  const base = slug(name) || template;
  return WINDOWS_RESERVED.test(base) ? `${base}-video` : base;
};

/**
 * Whether a failed render is worth one more in software: the encoder itself
 * failed (a hardware encoder that accepted the config and then broke, or one
 * that is missing), not the page or the loading of the encoder.
 */
const worthSoftwareRetry = (message: string): boolean =>
  /^Encoding failed|stopped answering \((?:start|frame \d+|finish)\)|no H\.264 video encoder/.test(
    message
  );

/** A name free in `directory`, so a second render never overwrites the first. */
const freeVideoPath = async (
  directory: string,
  base: string
): Promise<string> => {
  const taken = (file: string): Promise<boolean> =>
    fs.stat(file).then(
      () => true,
      () => false
    );
  let file = path.join(directory, `${base}.mp4`);
  for (let n = 2; await taken(file); n++)
    file = path.join(directory, `${base}-${n}.mp4`);
  return file;
};

const SEEK = (ms: number): string =>
  `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${ms}; });` +
  `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))`;

/** One render at a time: two would double the memory a low-end laptop has to find. */
let queue: Promise<unknown> = Promise.resolve();

export const renderMotion = (
  request: RenderMotionRequest,
  options: { preload?: string; software?: boolean } = {}
): Promise<MotionResult> => {
  const attempt = async (): Promise<MotionResult> => {
    try {
      return await render(request, options);
    } catch (error) {
      const inner = (error as Error).cause;
      if (typeof inner !== "string" || !worthSoftwareRetry(inner)) throw error;
      // Once more in software: slower, but present on every machine.
      return render(request, { ...options, software: true });
    }
  };
  const run = queue.then(attempt, attempt);
  queue = run.catch(() => undefined);
  return run;
};

const render = async (
  request: RenderMotionRequest,
  options: { preload?: string; software?: boolean }
): Promise<MotionResult> => {
  if (typeof request?.outputDir !== "string" || request.outputDir.trim() === "")
    throw new Error("An outputDir is required.");
  const built = planMotion(request);

  const directory = path.resolve(request.outputDir);
  await fs.mkdir(directory, { recursive: true });
  const videoPath = await freeVideoPath(
    directory,
    fileBase(
      slug(request.name ?? "") ||
        String(request.slots?.title ?? request.slots?.name ?? ""),
      built.template
    )
  );
  // The page is only the means: it renders from a folder of its own, so the
  // user's folder gets the video alone.
  const pageDir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-"));
  const htmlPath = path.join(pageDir, "page.html");
  await fs.writeFile(htmlPath, built.html, "utf8");

  const { width, height } = built;
  const frames = Math.max(1, Math.ceil(built.seconds * MOTION_FPS));
  const frameRect = { x: 0, y: 0, width, height };
  // A margin past the frame: the page is laid out in fixed pixels, and a
  // window exactly the size of the screen is shrunk by a pixel on Linux so it
  // does not read as full screen. Only the frame's rectangle is captured.
  const windowWidth = width + WINDOW_MARGIN;
  const windowHeight = height + WINDOW_MARGIN;
  const win = new BrowserWindow({
    show: false,
    width: windowWidth,
    height: windowHeight,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      preload:
        options.preload ??
        path.join(import.meta.dirname, "../preload/index.cjs"),
      additionalArguments: ["--abacus-window=motion"],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  // A preload that fails to load leaves nothing to answer motion:start; say
  // why at once rather than after the step timeout.
  let preloadError: string | null = null;
  contents.on("preload-error", (_event, _path, error) => {
    preloadError = error.message;
  });
  // The page is ours and static: it has nowhere to go.
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  const waiting = new Map<string, (args: unknown[]) => void>();
  for (const channel of ["motion:ready", "motion:ack", "motion:done"])
    contents.ipc.on(channel, (_event, ...args: unknown[]) => {
      const resolve = waiting.get(channel);
      waiting.delete(channel);
      resolve?.(args);
    });
  const reply = (channel: string, step: string): Promise<unknown[]> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(channel);
        reject(new Error(`The video encoder stopped answering (${step}).`));
      }, STEP_TIMEOUT_MS);
      waiting.set(channel, (args) => {
        clearTimeout(timer);
        resolve(args);
      });
    });

  try {
    // A window is created no taller than the screen, offscreen or not; this
    // lifts that, and the check below proves it worked.
    win.setContentSize(windowWidth, windowHeight);
    await win.loadFile(htmlPath);
    if (preloadError != null)
      throw new Error(`the video encoder did not load (${preloadError})`);
    // Type has to fit before the first frame (motion-plan.ts FIT_SCRIPT).
    const viewport = (await contents.executeJavaScript(
      `new Promise((r) => { const t = Date.now(); (function wait() { if (window.__motionReady || Date.now() - t > 5000) r([innerWidth, innerHeight]); else setTimeout(wait, 20); })(); })`
    )) as [number, number];
    // Never scale a wrong-sized page to fit: a 9:16 laid out square and
    // stretched tall looks broken, and the user would only find out on their phone.
    if (viewport[0] < width || viewport[1] < height)
      throw new Error(
        `The page laid out at ${viewport[0]}×${viewport[1]} instead of ${width}×${height}.`
      );

    const ready = reply("motion:ready", "start");
    contents.send("motion:start", {
      width,
      height,
      fps: MOTION_FPS,
      software: options.software === true,
    });
    const [started] = (await ready) as [{ codec?: string; error?: string }];
    if (started?.error != null || started?.codec == null)
      throw new Error(started?.error ?? "The video encoder did not start.");

    for (let index = 0; index < frames; index++) {
      // The page's clock runs timeScale times the video's: "fast" skips ahead.
      await contents.executeJavaScript(
        SEEK(((index * 1000) / MOTION_FPS) * built.timeScale)
      );
      let image: NativeImage = await contents.capturePage(frameRect);
      const captured = image.getSize();
      // A high-DPI display captures more pixels than the frame has.
      if (captured.width !== width || captured.height !== height)
        image = image.resize({ width, height, quality: "best" });
      const acked = reply("motion:ack", `frame ${index + 1}`);
      contents.send("motion:frame", image.toBitmap(), width, height, index);
      const [, failure] = (await acked) as [number, string | null];
      if (failure != null) throw new Error(`Encoding failed: ${failure}`);
    }

    const done = reply("motion:done", "finish");
    contents.send("motion:finish");
    const [finished] = (await done) as [{ bytes?: Uint8Array; error?: string }];
    if (finished?.bytes == null)
      throw new Error(
        `Encoding failed: ${finished?.error ?? "no video came back"}`
      );
    await fs.writeFile(videoPath, finished.bytes);

    return {
      videoPath,
      template: built.template,
      size: built.size,
      width,
      height,
      seconds: built.seconds,
      frames,
      warnings: built.warnings,
    };
  } catch (error) {
    // The plan was valid (planMotion threw before anything was written), so
    // this is the machine, not the words: the model must not keep re-planning.
    await fs.rm(videoPath, { force: true });
    const inner = (error as Error).message;
    throw new Error(
      `${RENDER_FAILED}: ${inner.replace(/\.$/, "")}. A different plan will not fix this.`,
      { cause: inner }
    );
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await fs.rm(pageDir, { recursive: true, force: true });
  }
};
