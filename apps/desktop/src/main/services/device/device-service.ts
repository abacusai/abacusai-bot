import { execFile, execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Worker } from "worker_threads";

import { abacusBotHome } from "../../paths";
import { shellCommandLine } from "../workspace/windows-shell";
import { AndroidInputClient, typableText } from "./android-input-client";
import { SimInputClient, type KeyModifiers } from "./sim-input-client";

/**
 * `KeyboardEvent.code` to USB HID usage (page 0x07). Positional on purpose:
 * the sim applies the host's layout, so any layout round-trips.
 */
const HID_USAGE_BY_CODE: Map<string, number> = (() => {
  // A Map, not a record: the code comes off IPC, and a record answers for
  // every Object.prototype name too.
  const m = new Map<string, number>();
  for (let i = 0; i < 26; i++)
    m.set(`Key${String.fromCharCode(65 + i)}`, 0x04 + i);
  for (let d = 1; d <= 9; d++) m.set(`Digit${d}`, 0x1e + (d - 1));
  m.set("Digit0", 0x27);
  for (const [code, usage] of Object.entries({
    Enter: 0x28,
    Escape: 0x29,
    Backspace: 0x2a,
    Tab: 0x2b,
    Space: 0x2c,
    Minus: 0x2d,
    Equal: 0x2e,
    BracketLeft: 0x2f,
    BracketRight: 0x30,
    Backslash: 0x31,
    Semicolon: 0x33,
    Quote: 0x34,
    Backquote: 0x35,
    Comma: 0x36,
    Period: 0x37,
    Slash: 0x38,
    ArrowRight: 0x4f,
    ArrowLeft: 0x50,
    ArrowDown: 0x51,
    ArrowUp: 0x52,
  }))
    m.set(code, usage);
  return m;
})();

/** `KeyboardEvent.code` → AndroidInputClient keyEvent name, for non-text keys. */
const ANDROID_KEY_BY_CODE = new Map<string, string>([
  ["Enter", "enter"],
  ["Backspace", "delete"],
  ["Tab", "tab"],
  ["Escape", "back"],
]);

/**
 * Host driver for iOS simulators (simctl) and Android emulators/devices
 * (adb). Pure node; McpDeviceServer exposes it as MCP tools. iOS interaction
 * goes through Maestro when installed, since simctl has no input synthesis.
 */

export type DevicePlatform = "ios" | "android";

export interface DeviceInfo {
  platform: DevicePlatform;
  /** simctl UDID or adb serial (for a not-yet-running AVD, the AVD name). */
  id: string;
  name: string;
  state: "booted" | "shutdown" | "unknown";
  os?: string;
  /** True for a physical device attached over USB (Android only for now). */
  physical?: boolean;
}

export interface InteractArgs {
  action: string;
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: string;
  amount?: number;
  deviceId?: string;
}

/**
 * A node from `maestro hierarchy`. iOS never sets `clickable` and keeps its
 * labels in `title` / `value` / `hintText`, so Android-shaped reads see nothing.
 */
interface MaestroNode {
  attributes?: {
    text?: string;
    accessibilityText?: string;
    title?: string;
    value?: string;
    hintText?: string;
    "resource-id"?: string;
    resourceId?: string;
    bounds?: string;
    clickable?: string;
    enabled?: string;
  };
  children?: MaestroNode[];
}

export interface BuildResult {
  success: boolean;
  artifactPath?: string;
  appId?: string;
  output: string;
}

const TEMP_DIR = path.join(abacusBotHome(), "temp");

/** First argument that is a non-empty string once trimmed, else ''. */
const firstNonEmpty = (...values: Array<string | undefined>): string => {
  for (const value of values) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") return trimmed;
  }
  return "";
};

/** Width/height from a PNG IHDR, without pulling in an image library. */
const readPngSize = (
  buffer: Buffer
): { width: number; height: number } | null => {
  // 8-byte signature, then a 4-byte length + "IHDR" + width/height big-endian.
  if (buffer.length < 24 || buffer.toString("ascii", 12, 16) !== "IHDR")
    return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const tail = (text: string, chars = 6000): string =>
  text.length > chars ? `…${text.slice(-chars)}` : text;

/** Maestro banners/notification boxes surround its JSON. Silence what we can
 *  and extract the first balanced JSON object from mixed output. */
const MAESTRO_ENV = {
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: "true",
  MAESTRO_CLI_NO_ANALYTICS: "1",
  MAESTRO_DISABLE_UPDATE_CHECK: "true",
};

const extractJsonObject = (text: string): string | null => {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
};

/** One `<node>` from a uiautomator dump, with its children. */
interface AndroidNode {
  text: string;
  resourceId: string;
  className: string;
  contentDesc: string;
  clickable: boolean;
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
  children: AndroidNode[];
}

const androidAttr = (tag: string, name: string): string =>
  tag.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

/**
 * uiautomator XML to a tree. Android puts the click handler on a container
 * and the words in a child TextView, so a flat parse leaves rows nameless.
 */
const parseAndroidHierarchy = (xml: string): AndroidNode[] => {
  const roots: AndroidNode[] = [];
  const stack: AndroidNode[] = [];
  const tagRe = /<node\b([^>]*?)(\/?)>|<\/node\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) != null) {
    if (m[1] === undefined) {
      stack.pop();
      continue;
    }
    const raw = m[1];
    const bounds = raw.match(/bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/);
    const node: AndroidNode = {
      text: androidAttr(raw, "text"),
      resourceId: androidAttr(raw, "resource-id"),
      className: androidAttr(raw, "class"),
      contentDesc: androidAttr(raw, "content-desc"),
      clickable: androidAttr(raw, "clickable") === "true",
      bounds:
        bounds != null
          ? {
              x1: Number(bounds[1]),
              y1: Number(bounds[2]),
              x2: Number(bounds[3]),
              y2: Number(bounds[4]),
            }
          : null,
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent != null) parent.children.push(node);
    else roots.push(node);
    if (m[2] !== "/") stack.push(node);
  }
  return roots;
};

/** Nearest text under this node, for a clickable container that carries none itself. */
const androidDescendantLabel = (node: AndroidNode): string => {
  for (const child of node.children) {
    const own = firstNonEmpty(child.text, child.contentDesc);
    if (own !== "") return own;
    const deeper = androidDescendantLabel(child);
    if (deeper !== "") return deeper;
  }
  return "";
};

/** Snapshot lines + the tap point for each @eN, in document order. */
export const renderAndroidSnapshot = (
  xml: string
): { lines: string[]; points: Array<{ x: number; y: number }> } => {
  const lines: string[] = [];
  const points: Array<{ x: number; y: number }> = [];
  const walk = (node: AndroidNode): void => {
    const own = firstNonEmpty(node.text, node.contentDesc);
    // A clickable container inherits the first words underneath it.
    const label =
      node.clickable && own === "" ? androidDescendantLabel(node) : own;
    const shortClass = node.className.split(".").pop() ?? node.className;
    if (node.clickable && node.bounds != null) {
      points.push({
        x: Math.round((node.bounds.x1 + node.bounds.x2) / 2),
        y: Math.round((node.bounds.y1 + node.bounds.y2) / 2),
      });
      const idPart =
        node.resourceId !== "" ? ` id=${node.resourceId.split("/").pop()}` : "";
      lines.push(`@e${points.length} ${shortClass}${idPart} "${label}"`);
    } else if (own !== "") {
      lines.push(`(text) ${shortClass} "${own}"`);
    }
    for (const child of node.children) walk(child);
  };
  for (const root of parseAndroidHierarchy(xml)) walk(root);
  return { lines, points };
};

const run = (
  file: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    binary?: boolean;
    env?: Record<string, string>;
  } = {}
): Promise<{ stdout: string; stderr: string; buffer?: Buffer }> =>
  new Promise((resolve, reject) => {
    // Node refuses .bat/.cmd without a shell (CVE-2024-27980), and a shell
    // re-parses arguments, so hand it one pre-quoted line (windows-shell.ts).
    const needsShell =
      process.platform === "win32" && /\.(bat|cmd)$/i.test(file);
    execFile(
      needsShell ? shellCommandLine(file, args) : file,
      needsShell ? [] : args,
      {
        shell: needsShell,
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: opts.binary ? ("buffer" as const) : ("utf-8" as const),
        env: opts.env != null ? { ...process.env, ...opts.env } : undefined,
      },
      (err, stdout, stderr) => {
        const out = opts.binary ? "" : (stdout as unknown as string);
        const errOut = opts.binary ? "" : (stderr as unknown as string);
        if (err != null) {
          // Tail each stream separately: tailing the concatenation drops
          // Gradle's stderr, the one place it prints "What went wrong".
          const parts = [
            errOut?.trim() ? tail(errOut.trim(), 4000) : "",
            out?.trim() ? tail(out.trim(), 2000) : "",
          ].filter((p) => p !== "");
          const detail = parts.join("\n");
          reject(new Error(detail !== "" ? detail : err.message));
          return;
        }
        resolve({
          stdout: out,
          stderr: errOut,
          buffer: opts.binary ? (stdout as unknown as Buffer) : undefined,
        });
      }
    );
  });

// --- Toolchain resolution ---

const findAndroidSdk = (): string | null => {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Android", "sdk")
      : null,
    process.platform === "linux"
      ? path.join(os.homedir(), "Android", "Sdk")
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA != null
      ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
      : null,
  ];
  for (const dir of candidates) {
    if (dir != null && fs.existsSync(dir)) return dir;
  }
  return null;
};

const exeName = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name;

/** Build for any simulator; the concrete device is chosen at install time. */
const IOS_SIM_DESTINATION = "generic/platform=iOS Simulator";

/** How deep to look for an Xcode/Gradle project below the workspace root. */
const XCODE_SCAN_DEPTH = 3;
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "Pods",
  "build",
  "DerivedData",
  ".git",
  ".abacusai-bot",
  "vendor",
  ".gradle",
  ".idea",
  "Carthage",
  "dist",
  "out",
  ".build",
]);

/**
 * Directories below `root`, breadth-first to `depth`, skipping dependency and
 * build trees, so the shallowest project wins.
 */
const shallowDirs = (root: string, depth: number): string[] => {
  const result: string[] = [];
  let frontier = [root];
  for (let level = 0; level < depth; level++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith("."))
          continue;
        // An .xcodeproj contains its own project.xcworkspace.
        if (
          entry.name.endsWith(".xcodeproj") ||
          entry.name.endsWith(".xcworkspace")
        )
          continue;
        const full = path.join(dir, entry.name);
        result.push(full);
        next.push(full);
      }
    }
    frontier = next;
  }
  return result;
};

export interface MobileToolchain {
  ios: boolean;
  android: boolean;
  adbPath: string | null;
  emulatorPath: string | null;
}

/**
 * Rank JDKs for Gradle. Not "newest wins": Gradle 8.x refuses anything past
 * 22 and AGP needs 17+. Newest in 17..21 first, then anything runnable.
 */
export const pickGradleJdk = <T extends { home: string; version: number }>(
  candidates: T[]
): T | undefined => {
  const newestFirst = [...candidates].sort((a, b) => b.version - a.version);

  // The range AGP and Gradle both accept.
  const preferred = newestFirst.find((c) => c.version >= 17 && c.version <= 21);
  if (preferred != null) return preferred;

  // Nothing ideal; still skip the JDKs Gradle refuses outright.
  const runnable = newestFirst.find((c) => c.version >= 17 && c.version <= 22);
  if (runnable != null) return runnable;

  return newestFirst[0];
};

/**
 * Set `key=value` in ini text, keeping the file's own line endings (CRLF on
 * Windows). A missing key is appended before the trailing newline.
 */
export const upsertIniLine = (
  text: string,
  key: string,
  value: string
): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    next.push(`${key}=${value}`, "");
  }
  return next.join(eol);
};

/** Major version of a JDK install, from its `release` file or its path. */
const jdkVersion = (home: string): number => {
  try {
    const release = fs.readFileSync(path.join(home, "release"), "utf-8");
    const m = release.match(/JAVA_VERSION="(\d+)/);
    if (m != null) return Number(m[1]);
  } catch {
    /* no release file: fall back to the path */
  }
  const fromPath = home.match(/(?:openjdk|jdk|temurin|zulu)[@-]?(\d+)/i);
  return fromPath != null ? Number(fromPath[1]) : 0;
};

/** A filter that has not finished by now is not going to. */
const LOG_FILTER_TIMEOUT_MS = 1_000;

/** Runs one regex over the lines it is handed and reports what matched. */
const LOG_FILTER_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.filter, "i");
parentPort.postMessage(workerData.lines.filter((line) => re.test(line)));
`;

/**
 * Runs the log filter in a worker with a deadline: the pattern comes from the
 * model and may backtrack catastrophically.
 */
export async function filterLogLines(
  lines: string[],
  filter: string,
  timeoutMs = LOG_FILTER_TIMEOUT_MS
): Promise<string[]> {
  try {
    new RegExp(filter, "i");
  } catch (e) {
    throw new Error(
      `Invalid filter regex ${JSON.stringify(filter)}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  const worker = new Worker(LOG_FILTER_WORKER, {
    eval: true,
    workerData: { lines, filter },
  });
  return new Promise<string[]>((resolve, reject) => {
    const finish = (fn: () => void): void => {
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Filter ${JSON.stringify(filter)} did not finish within ${timeoutMs}ms. Use a simpler pattern.`
          )
        )
      );
    }, timeoutMs);
    worker.on("message", (matched: string[]) => {
      finish(() => resolve(matched));
    });
    worker.on("error", (err: Error) => {
      finish(() => reject(err));
    });
    worker.on("exit", () => {
      finish(() =>
        reject(new Error("Log filter worker stopped unexpectedly."))
      );
    });
  });
}

export class DeviceService {
  private toolchain: MobileToolchain | null = null;
  private maestroPath: string | null | undefined = undefined;
  /** @eN → {deviceId, x, y} from the last snapshot (either platform). */
  private refMap = new Map<
    string,
    { deviceId: string; x: number; y: number }
  >();
  /** Points, from the hierarchy-root bounds. */
  private iosScreenPoints = new Map<string, { w: number; h: number }>();
  /** Pixels, per serial. */
  private androidScreen = new Map<string, { w: number; h: number }>();
  private readonly simInput = new SimInputClient();
  private readonly androidInput = new AndroidInputClient(
    () => this.getToolchain().adbPath
  );
  /** Devices this app booted (iOS UDIDs + Android `emulator-*` serials), shut
   *  down on quit. Devices the user booted are never added. */
  private readonly bootedByUs = new Set<string>();
  /** The set above, mirrored to disk: a hard kill skips `before-quit`, and
   *  nothing else would remember the sims were ours. */
  private readonly bootedStateFile = path.join(
    abacusBotHome(),
    "booted-devices.json"
  );
  private bootedStateLoaded = false;

  private loadBootedByUs(): void {
    if (this.bootedStateLoaded) return;
    this.bootedStateLoaded = true;
    try {
      const raw: unknown = JSON.parse(
        fs.readFileSync(this.bootedStateFile, "utf8")
      );
      if (Array.isArray(raw)) {
        for (const id of raw)
          if (typeof id === "string" && id !== "") this.bootedByUs.add(id);
      }
    } catch {
      /* no state from a previous run */
    }
  }

  private persistBootedByUs(): void {
    try {
      fs.mkdirSync(path.dirname(this.bootedStateFile), { recursive: true });
      fs.writeFileSync(
        this.bootedStateFile,
        JSON.stringify([...this.bootedByUs])
      );
    } catch {
      /* best effort: quit-time cleanup still works this run */
    }
  }

  private markBootedByUs(id: string): void {
    this.loadBootedByUs();
    this.bootedByUs.add(id);
    this.persistBootedByUs();
  }

  /** macOS-arm64 only. */
  hasNativeIosInput(): boolean {
    return this.simInput.isSupported();
  }

  /** Normalized 0..1. */
  async iosTouch(
    deviceId: string,
    phase: "down" | "move" | "up",
    nx: number,
    ny: number
  ): Promise<boolean> {
    return this.simInput.touch(deviceId, phase, nx, ny);
  }

  async iosKeyPress(
    deviceId: string,
    code: string,
    mods: KeyModifiers
  ): Promise<boolean> {
    const usage = HID_USAGE_BY_CODE.get(code);
    if (usage == null) return false;
    return this.simInput.keyPress(deviceId, usage, mods);
  }

  /**
   * Printable characters go through `adb input text` (layout-independent);
   * everything else maps to a keyevent by physical code.
   */
  androidKey(
    serial: string,
    code: string,
    key: string,
    mods: KeyModifiers
  ): boolean {
    const noMod = mods.ctrl !== true && mods.meta !== true && mods.alt !== true;
    if (noMod && key.length === 1) return this.androidInput.text(serial, key);
    const named = ANDROID_KEY_BY_CODE.get(code);
    if (named == null) return false;
    return this.androidInput.keyEvent(serial, named);
  }

  disposeIosInput(deviceId: string): void {
    this.simInput.disposeDevice(deviceId);
  }

  /** Maestro binary, when installed (enables iOS snapshot/interact). */
  getMaestroPath(): string | null {
    if (this.maestroPath !== undefined) return this.maestroPath;
    const candidates = [
      path.join(os.homedir(), ".maestro", "bin", exeName("maestro")),
      "/opt/homebrew/bin/maestro",
      "/usr/local/bin/maestro",
    ];
    this.maestroPath = candidates.find((p) => fs.existsSync(p)) ?? null;
    return this.maestroPath;
  }

  /** Re-probe for Xcode / the Android SDK; the cache otherwise lives for the
   *  whole process, so a toolchain installed mid-session goes unnoticed. */
  refreshToolchain(): MobileToolchain {
    this.toolchain = null;
    this.maestroPath = undefined;
    return this.getToolchain();
  }

  /**
   * Not `existsSync('/usr/bin/xcrun')`: the Command Line Tools ship xcrun
   * without simctl. simctl lives in the selected developer dir.
   */
  private detectIosToolchain(): boolean {
    if (process.platform !== "darwin") return false;
    try {
      const developerDir = execFileSync("/usr/bin/xcode-select", ["-p"], {
        timeout: 5000,
        encoding: "utf-8",
      }).trim();
      if (developerDir === "") return false;
      return fs.existsSync(path.join(developerDir, "usr", "bin", "simctl"));
    } catch {
      return false;
    }
  }

  getToolchain(): MobileToolchain {
    if (this.toolchain != null) return this.toolchain;
    const sdk = findAndroidSdk();
    const adbPath =
      sdk != null ? path.join(sdk, "platform-tools", exeName("adb")) : null;
    const emulatorPath =
      sdk != null ? path.join(sdk, "emulator", exeName("emulator")) : null;
    this.toolchain = {
      ios: this.detectIosToolchain(),
      android: adbPath != null && fs.existsSync(adbPath),
      adbPath: adbPath != null && fs.existsSync(adbPath) ? adbPath : null,
      emulatorPath:
        emulatorPath != null && fs.existsSync(emulatorPath)
          ? emulatorPath
          : null,
    };
    return this.toolchain;
  }

  isAvailable(): boolean {
    const tc = this.getToolchain();
    return tc.ios || tc.android;
  }

  private adb(): string {
    const p = this.getToolchain().adbPath;
    if (p == null)
      throw new Error(
        "adb not found. Install the Android SDK platform-tools or set ANDROID_HOME."
      );
    return p;
  }

  // --- Discovery ---

  async listDevices(): Promise<DeviceInfo[]> {
    return (await this.listDevicesDetailed()).devices;
  }

  /**
   * Each platform is enumerated independently and its failure recorded, so a
   * broken Xcode does not fail every Android tool with an iOS error.
   */
  async listDevicesDetailed(): Promise<{
    devices: DeviceInfo[];
    errors: Partial<Record<DevicePlatform, string>>;
  }> {
    const tc = this.getToolchain();
    const devices: DeviceInfo[] = [];
    const errors: Partial<Record<DevicePlatform, string>> = {};
    const collect = async (
      platform: DevicePlatform,
      list: () => Promise<DeviceInfo[]>
    ): Promise<void> => {
      try {
        devices.push(...(await list()));
      } catch (e) {
        errors[platform] = e instanceof Error ? e.message : String(e);
      }
    };
    if (tc.ios) await collect("ios", () => this.listIosSimulators());
    if (tc.android) await collect("android", () => this.listAndroidDevices());
    return { devices, errors };
  }

  private async listIosSimulators(): Promise<DeviceInfo[]> {
    const { stdout } = await run("/usr/bin/xcrun", [
      "simctl",
      "list",
      "devices",
      "available",
      "-j",
    ]);
    const parsed = JSON.parse(stdout) as {
      devices?: Record<
        string,
        Array<{ name?: string; udid?: string; state?: string }>
      >;
    };
    const result: DeviceInfo[] = [];
    for (const [runtime, devices] of Object.entries(parsed?.devices ?? {})) {
      // "com.apple.CoreSimulator.SimRuntime.iOS-26-4" → "iOS 26.4"
      const osName = runtime
        .replace(/^.*SimRuntime\./, "")
        .replace(/-/g, " ")
        .replace(/(\d+) (\d+)$/, "$1.$2");
      for (const d of devices ?? []) {
        if (d?.udid == null) continue;
        result.push({
          platform: "ios",
          id: d.udid,
          name: d.name ?? d.udid,
          state:
            d.state === "Booted"
              ? "booted"
              : d.state === "Shutdown"
                ? "shutdown"
                : "unknown",
          os: osName,
        });
      }
    }
    return result;
  }

  private async listAndroidDevices(): Promise<DeviceInfo[]> {
    const result: DeviceInfo[] = [];
    const running = new Set<string>();
    try {
      const { stdout } = await run(this.adb(), ["devices", "-l"]);
      for (const line of stdout.split("\n").slice(1)) {
        const m = line.trim().match(/^(\S+)\s+device(\s|$)/);
        if (m == null) continue;
        const serial = m[1];
        running.add(serial);
        const model = line.match(/model:(\S+)/)?.[1];
        let name = model ?? serial;
        if (serial.startsWith("emulator-")) {
          try {
            const { stdout: avdOut } = await run(
              this.adb(),
              ["-s", serial, "emu", "avd", "name"],
              {
                timeoutMs: 5000,
              }
            );
            name = avdOut.split("\n")[0]?.trim() || name;
          } catch {
            /* keep model/serial */
          }
        }
        result.push({
          platform: "android",
          id: serial,
          name,
          state: "booted",
          physical: !serial.startsWith("emulator-"),
        });
      }
    } catch {
      /* adb misbehaving: fall through to AVD list */
    }
    const tc = this.getToolchain();
    if (tc.emulatorPath != null) {
      try {
        const { stdout } = await run(tc.emulatorPath, ["-list-avds"]);
        const runningNames = new Set(result.map((d) => d.name));
        for (const line of stdout.split("\n")) {
          const avd = line.trim();
          // -list-avds sometimes prints INFO lines; AVD names have no spaces
          if (avd === "" || avd.includes(" ") || runningNames.has(avd))
            continue;
          result.push({
            platform: "android",
            id: avd,
            name: avd,
            state: "shutdown",
          });
        }
      } catch {
        /* no emulator binary output */
      }
    }
    return result;
  }

  /**
   * Resolves a target device for an operation. `idOrName` may be a UDID/serial,
   * an AVD/simulator name, or omitted (→ the booted device on that platform).
   */
  async resolveTarget(
    platform: DevicePlatform,
    idOrName?: string
  ): Promise<DeviceInfo> {
    const { devices: all, errors } = await this.listDevicesDetailed();
    const devices = all.filter((d) => d.platform === platform);
    // "No booted ios device" is a lie when simctl failed; report the cause.
    if (devices.length === 0 && errors[platform] != null) {
      throw new Error(
        `Could not list ${platform} devices: ${errors[platform]}`
      );
    }
    if (idOrName != null && idOrName.trim() !== "") {
      const needle = idOrName.trim().toLowerCase();
      const found =
        devices.find((d) => d.id.toLowerCase() === needle) ??
        devices.find((d) => d.name.toLowerCase() === needle) ??
        devices.find((d) => d.name.toLowerCase().includes(needle));
      if (found == null)
        throw new Error(
          `No ${platform} device matching "${idOrName}". Use device_list to see devices.`
        );
      return found;
    }
    const booted = devices.filter((d) => d.state === "booted");
    if (booted.length === 0)
      throw new Error(
        `No booted ${platform} device. Boot one with device_boot first.`
      );
    return booted[0];
  }

  // --- Lifecycle ---

  /**
   * Simulator.app must show this device's window or CoreSimulator composites
   * one static frame. -g so it never steals focus; `-CurrentDeviceUDID` since a
   * bare launch can open no window. ShowChrome=false is read at creation, so a
   * stale bezeled instance is relaunched once.
   */
  private async ensureSimulatorUi(
    focus: boolean,
    udid?: string
  ): Promise<void> {
    try {
      let showChrome = "";
      try {
        const { stdout } = await run(
          "/usr/bin/defaults",
          ["read", "com.apple.iphonesimulator", "ShowChrome"],
          { timeoutMs: 5000 }
        );
        showChrome = stdout.trim();
      } catch {
        /* key unset: Simulator defaults to bezels on */
      }
      if (showChrome !== "0") {
        await run("/usr/bin/defaults", [
          "write",
          "com.apple.iphonesimulator",
          "ShowChrome",
          "-bool",
          "false",
        ]);
        try {
          await run("/usr/bin/killall", ["Simulator"], { timeoutMs: 5000 });
        } catch {
          /* not running */
        }
      }
    } catch {
      /* cosmetic: the mirror still works, taps may be slightly off */
    }
    const openArgs = focus ? ["-a", "Simulator"] : ["-g", "-a", "Simulator"];
    if (udid != null) openArgs.push("--args", "-CurrentDeviceUDID", udid);
    try {
      await run("/usr/bin/open", openArgs);
    } catch {
      /* mirror falls back to polling */
    }
  }

  async boot(
    platform: DevicePlatform,
    idOrName?: string,
    opts: { focus?: boolean } = {}
  ): Promise<DeviceInfo> {
    const device = await (async () => {
      const { devices: all, errors } = await this.listDevicesDetailed();
      const devices = all.filter((d) => d.platform === platform);
      if (devices.length === 0 && errors[platform] != null) {
        throw new Error(
          `Could not list ${platform} devices: ${errors[platform]}`
        );
      }
      if (idOrName != null && idOrName.trim() !== "") {
        const needle = idOrName.trim().toLowerCase();
        const found =
          devices.find((d) => d.id.toLowerCase() === needle) ??
          devices.find((d) => d.name.toLowerCase() === needle) ??
          devices.find((d) => d.name.toLowerCase().includes(needle));
        if (found == null)
          throw new Error(`No ${platform} device matching "${idOrName}".`);
        return found;
      }
      // Prefer already-booted, then first shutdown device
      return devices.find((d) => d.state === "booted") ?? devices[0];
    })();
    if (device == null) throw new Error(`No ${platform} devices available.`);
    if (device.state === "booted") {
      // The mirror is headless; Simulator.app is only surfaced on request.
      if (platform === "ios") {
        if (opts.focus === true) await this.ensureSimulatorUi(true, device.id);
        // simctl says "Booted" before SpringBoard composites; don't race it.
        try {
          await run(
            "/usr/bin/xcrun",
            ["simctl", "bootstatus", device.id, "-b"],
            {
              timeoutMs: 120_000,
            }
          );
        } catch {
          /* booted enough for most operations */
        }
      }
      return device;
    }

    if (platform === "ios") {
      try {
        await run("/usr/bin/xcrun", ["simctl", "boot", device.id], {
          timeoutMs: 60_000,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!msg.includes("current state: Booted")) throw e;
      }
      // `simctl boot` is headless; the mirror reads the framebuffer directly.
      if (opts.focus === true) await this.ensureSimulatorUi(true, device.id);
      try {
        await run("/usr/bin/xcrun", ["simctl", "bootstatus", device.id, "-b"], {
          timeoutMs: 120_000,
        });
      } catch {
        /* booted enough for most operations */
      }
      this.markBootedByUs(device.id);
      return { ...device, state: "booted" };
    }

    // Android: spawn the emulator detached and wait for boot_completed
    const tc = this.getToolchain();
    if (tc.emulatorPath == null)
      throw new Error("Android emulator binary not found in the SDK.");
    // Headless like the iOS mirror; the panel streams via scrcpy. `-gpu host`,
    // not `auto`: with `-no-window`, auto picks SwiftShader (~10fps, ANRs).
    const emulatorArgs = ["-avd", device.id, "-no-boot-anim", "-no-audio"];
    if (opts.focus === true) {
      emulatorArgs.push("-gpu", "auto");
    } else {
      emulatorArgs.push("-gpu", "host", "-no-window");
    }
    // detached is POSIX-only: on Windows it opens a console window and lets
    // the emulator outlive the app with nothing able to kill it.
    const onWindows = process.platform === "win32";
    const child = spawn(tc.emulatorPath, emulatorArgs, {
      detached: !onWindows,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const booted = (await this.listAndroidDevices()).find(
          (d) => d.state === "booted" && d.name === device.id
        );
        if (booted != null) {
          const { stdout } = await run(
            this.adb(),
            ["-s", booted.id, "shell", "getprop", "sys.boot_completed"],
            { timeoutMs: 5000 }
          );
          if (stdout.trim() === "1") {
            this.markBootedByUs(booted.id);
            return booted;
          }
        }
      } catch {
        /* still booting */
      }
    }
    throw new Error(
      `Emulator "${device.id}" did not finish booting within 3 minutes.`
    );
  }

  /**
   * Create from what is already installed: a runtime or system image is a
   * multi-GB download not to start behind a button, so say what to install.
   */
  async createDevice(platform: DevicePlatform): Promise<DeviceInfo> {
    return platform === "ios"
      ? this.createIosSimulator()
      : this.createAndroidEmulator();
  }

  private async createIosSimulator(): Promise<DeviceInfo> {
    if (process.platform !== "darwin")
      throw new Error("iOS simulators are only available on macOS.");
    const { stdout: runtimesOut } = await run(
      "/usr/bin/xcrun",
      ["simctl", "list", "runtimes", "-j"],
      { timeoutMs: 30_000 }
    );
    const runtimes =
      (
        JSON.parse(runtimesOut) as {
          runtimes?: Array<{
            identifier: string;
            version: string;
            isAvailable?: boolean;
            name?: string;
          }>;
        }
      ).runtimes?.filter(
        (r) => r.isAvailable !== false && r.identifier.includes("iOS")
      ) ?? [];
    if (runtimes.length === 0) {
      throw new Error(
        "No iOS runtime is installed. In Xcode: Settings → Components → install an iOS Simulator runtime, then try again."
      );
    }
    const byVersion = (
      a: { version: string },
      b: { version: string }
    ): number =>
      b.version.localeCompare(a.version, undefined, { numeric: true });
    const runtime = [...runtimes].sort(byVersion)[0];
    const { stdout: typesOut } = await run(
      "/usr/bin/xcrun",
      ["simctl", "list", "devicetypes", "-j"],
      { timeoutMs: 30_000 }
    );
    const iphones =
      (
        JSON.parse(typesOut) as {
          devicetypes?: Array<{ identifier: string; name: string }>;
        }
      ).devicetypes?.filter((t) => t.name.startsWith("iPhone")) ?? [];
    if (iphones.length === 0)
      throw new Error("Xcode reports no iPhone device types.");
    // simctl only rejects a type/runtime pair at create time; walk the newest.
    let lastError = "";
    for (const type of iphones.slice(0, 5)) {
      try {
        const { stdout } = await run(
          "/usr/bin/xcrun",
          ["simctl", "create", type.name, type.identifier, runtime.identifier],
          { timeoutMs: 120_000 }
        );
        const udid = stdout.trim();
        return {
          platform: "ios",
          id: udid,
          name: type.name,
          state: "shutdown",
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(
      `Could not create a simulator on ${runtime.name ?? runtime.identifier}: ${tail(lastError, 400)}`
    );
  }

  private async createAndroidEmulator(): Promise<DeviceInfo> {
    const sdkRoot = findAndroidSdk();
    if (sdkRoot == null)
      throw new Error(
        "Android SDK not found. Install Android Studio, then try again."
      );
    // avdmanager is a .bat on Windows, not a .exe; exeName() would miss it.
    const avdBin =
      process.platform === "win32" ? "avdmanager.bat" : "avdmanager";
    const avdmanager = [
      path.join(sdkRoot, "cmdline-tools", "latest", "bin", avdBin),
      path.join(sdkRoot, "tools", "bin", avdBin),
    ].find((p) => fs.existsSync(p));
    if (avdmanager == null) {
      throw new Error(
        'The Android SDK command-line tools are missing. In Android Studio: Settings → SDK Tools → check "Android SDK Command-line Tools".'
      );
    }
    const image = this.newestSystemImage(sdkRoot);
    if (image == null) {
      throw new Error(
        'No Android system image is installed. In Android Studio: Settings → SDK Manager → SDK Platforms → check "Show package details" and install a system image, then try again.'
      );
    }
    const name = `AbacusBot_${image.api.replace(/[^\w.]/g, "_")}`;
    const profile = await this.pickAvdDeviceProfile(avdmanager, sdkRoot);
    // avdmanager is a Java tool and prompts for a custom hardware profile.
    const jdk = this.resolveGradleJavaHome(sdkRoot);
    const env: Record<string, string> = {
      ANDROID_SDK_ROOT: sdkRoot,
      ANDROID_HOME: sdkRoot,
    };
    if (jdk.home != null) env.JAVA_HOME = jdk.home;
    const createArgs = [
      "create",
      "avd",
      "-n",
      name,
      "-k",
      image.pkg,
      "--force",
    ];
    // A profile-less AVD is 320x640 with no keyboard, and scrcpy's Controller
    // NPEs without a keyboard input device, so the mirror never starts.
    if (profile != null) createArgs.push("-d", profile);
    await new Promise<string>((resolve, reject) => {
      // Windows needs a shell for .bat, and a shell would split the package
      // id and SDK path, so it gets one pre-quoted line (windows-shell.ts).
      const onWindows = process.platform === "win32";
      const child = onWindows
        ? spawn(shellCommandLine(avdmanager, createArgs), {
            env: { ...process.env, ...env },
            shell: true,
          })
        : spawn(avdmanager, createArgs, { env: { ...process.env, ...env } });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        out += d.toString();
      });
      child.stdin?.write("no\n"); // "Do you wish to create a custom hardware profile?"
      child.stdin?.end();
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve(out)
          : reject(new Error(tail(out, 600) || `avdmanager exited ${code}`))
      );
    });
    this.enableAvdKeyboard(name);
    return { platform: "android", id: name, name, state: "shutdown" };
  }

  /**
   * `avdmanager` writes `hw.keyboard=no` even with a device profile, which
   * breaks typing and makes scrcpy's Controller NPE before the first frame.
   */
  private enableAvdKeyboard(name: string): void {
    const avdHome =
      process.env.ANDROID_AVD_HOME ??
      path.join(os.homedir(), ".android", "avd");
    const config = path.join(avdHome, `${name}.avd`, "config.ini");
    try {
      const text = fs.readFileSync(config, "utf-8");
      fs.writeFileSync(config, upsertIniLine(text, "hw.keyboard", "yes"));
    } catch {
      /* no config.ini: the AVD still boots, just without a keyboard */
    }
  }

  /** Prefer a recent Pixel hardware profile; fall back to whatever exists. */
  private async pickAvdDeviceProfile(
    avdmanager: string,
    sdkRoot: string
  ): Promise<string | null> {
    try {
      const { stdout } = await run(avdmanager, ["list", "device", "-c"], {
        timeoutMs: 60_000,
        env: { ANDROID_SDK_ROOT: sdkRoot, ANDROID_HOME: sdkRoot },
      });
      const ids = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.includes(" "));
      for (const preferred of ["pixel_7", "pixel_6", "pixel_5", "pixel_4"]) {
        if (ids.includes(preferred)) return preferred;
      }
      return ids.find((id) => id.startsWith("pixel")) ?? null;
    } catch (e) {
      // Usable without a profile, but a failing avdmanager is worth surfacing.
      console.warn(
        `[device] avdmanager list device failed, creating AVD without a profile: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return null;
    }
  }

  /** Highest-API installed system image matching the host CPU, Play/Google APIs preferred. */
  private newestSystemImage(
    sdkRoot: string
  ): { pkg: string; api: string } | null {
    const root = path.join(sdkRoot, "system-images");
    const wantAbi = process.arch === "arm64" ? "arm64-v8a" : "x86_64";
    const found: Array<{ pkg: string; api: string; tagRank: number }> = [];
    const dirs = (p: string): string[] => {
      try {
        return fs
          .readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return [];
      }
    };
    for (const api of dirs(root)) {
      for (const tag of dirs(path.join(root, api))) {
        for (const abi of dirs(path.join(root, api, tag))) {
          if (abi !== wantAbi) continue;
          if (
            !fs.existsSync(path.join(root, api, tag, abi, "system.img")) &&
            !fs.existsSync(path.join(root, api, tag, abi, "build.prop"))
          )
            continue;
          const tagRank = tag.includes("playstore")
            ? 2
            : tag.includes("google_apis")
              ? 1
              : 0;
          found.push({
            pkg: `system-images;${api};${tag};${abi}`,
            api,
            tagRank,
          });
        }
      }
    }
    if (found.length === 0) return null;
    found.sort(
      (a, b) =>
        b.api.localeCompare(a.api, undefined, { numeric: true }) ||
        b.tagRank - a.tagRank
    );
    return { pkg: found[0].pkg, api: found[0].api };
  }

  async shutdown(platform: DevicePlatform, idOrName?: string): Promise<void> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run("/usr/bin/xcrun", ["simctl", "shutdown", device.id], {
        timeoutMs: 60_000,
      });
    } else if (device.id.startsWith("emulator-")) {
      await run(this.adb(), ["-s", device.id, "emu", "kill"]);
    } else {
      throw new Error("Refusing to shut down a physical Android device.");
    }
    this.loadBootedByUs();
    this.bootedByUs.delete(device.id);
    this.persistBootedByUs();
  }

  hasDevicesBootedByUs(): boolean {
    this.loadBootedByUs();
    return this.bootedByUs.size > 0;
  }

  /** Shut down every device this app booted, on quit. Best-effort and
   *  bounded, straight by id rather than through the slow `resolveTarget`. */
  async shutdownBootedByUs(): Promise<void> {
    this.loadBootedByUs();
    const ids = [...this.bootedByUs];
    this.bootedByUs.clear();
    this.persistBootedByUs();
    await Promise.all(
      ids.map(async (id) => {
        try {
          if (id.startsWith("emulator-")) {
            await run(this.adb(), ["-s", id, "emu", "kill"], {
              timeoutMs: 10_000,
            });
          } else {
            await run("/usr/bin/xcrun", ["simctl", "shutdown", id], {
              timeoutMs: 10_000,
            });
          }
        } catch {
          /* device already gone / adb missing: nothing to clean up */
        }
      })
    );
  }

  async installMaestro(): Promise<{ success: boolean; error?: string }> {
    if (process.platform === "win32") {
      return {
        success: false,
        error:
          "Automatic install is not supported on Windows. See docs.maestro.dev.",
      };
    }
    try {
      await run(
        "/bin/bash",
        ["-lc", 'curl -Ls "https://get.maestro.mobile.dev" | bash'],
        {
          timeoutMs: 300_000,
        }
      );
      this.maestroPath = undefined; // force re-detection
      if (this.getMaestroPath() == null) {
        return {
          success: false,
          error:
            "Installer finished but the maestro binary was not found at ~/.maestro/bin.",
        };
      }
      return { success: true };
    } catch (e) {
      this.maestroPath = undefined;
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // --- Project detection ---

  /**
   * Marker files are looked for at the root and in shallow subdirectories:
   * ./app, ./ios + ./android and monorepo packages are all normal layouts.
   */
  detectProjectPlatforms(workspacePath: string): {
    ios: boolean;
    android: boolean;
    framework: "flutter" | "react-native" | "native" | null;
  } {
    const roots = [
      workspacePath,
      ...shallowDirs(workspacePath, XCODE_SCAN_DEPTH),
    ];
    const hasFile = (file: string): boolean =>
      roots.some((dir) => fs.existsSync(path.join(dir, file)));
    let framework: "flutter" | "react-native" | "native" | null = null;
    if (hasFile("pubspec.yaml")) {
      framework = "flutter";
    } else {
      for (const dir of roots) {
        const manifest = path.join(dir, "package.json");
        if (!fs.existsSync(manifest)) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(manifest, "utf-8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          if (
            pkg?.dependencies?.["react-native"] != null ||
            pkg?.devDependencies?.["react-native"] != null
          ) {
            framework = "react-native";
            break;
          }
        } catch {
          /* unreadable package.json: keep looking */
        }
      }
    }
    const ios =
      process.platform === "darwin" &&
      this.findXcodeContainer(workspacePath) != null;
    const android =
      this.findGradleRoot(workspacePath) != null ||
      hasFile("settings.gradle") ||
      hasFile("settings.gradle.kts");
    if ((ios || android) && framework == null) framework = "native";
    return { ios, android, framework };
  }

  // --- Build ---

  async build(
    workspacePath: string,
    platform: DevicePlatform,
    opts: { scheme?: string; configuration?: string } = {}
  ): Promise<BuildResult> {
    return platform === "ios"
      ? await this.buildIos(workspacePath, opts)
      : await this.buildAndroid(workspacePath);
  }

  /** Locate the Xcode container: well-known spots first, then a shallow scan
   *  so an app under ./app or a monorepo package is still found. */
  private findXcodeContainer(
    workspacePath: string
  ): { flag: "-workspace" | "-project"; path: string } | null {
    const pick = (
      dir: string
    ): { flag: "-workspace" | "-project"; path: string } | null => {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return null;
      }
      const ws = entries.find((e) => e.endsWith(".xcworkspace"));
      if (ws != null) return { flag: "-workspace", path: path.join(dir, ws) };
      const proj = entries.find((e) => e.endsWith(".xcodeproj"));
      if (proj != null) return { flag: "-project", path: path.join(dir, proj) };
      return null;
    };
    for (const dir of [
      workspacePath,
      path.join(workspacePath, "ios"),
      path.join(workspacePath, "app"),
    ]) {
      const hit = pick(dir);
      if (hit != null) return hit;
    }
    for (const dir of shallowDirs(workspacePath, XCODE_SCAN_DEPTH)) {
      const hit = pick(dir);
      if (hit != null) return hit;
    }
    return null;
  }

  /** Gradle project root: workspace root, ./android, or a shallow scan for gradlew. */
  private findGradleRoot(workspacePath: string): string | null {
    const hasGradlew = (dir: string): boolean =>
      fs.existsSync(path.join(dir, "gradlew")) ||
      fs.existsSync(path.join(dir, "gradlew.bat"));
    for (const dir of [
      workspacePath,
      path.join(workspacePath, "android"),
      path.join(workspacePath, "app"),
    ]) {
      if (fs.existsSync(dir) && hasGradlew(dir)) return dir;
    }
    return (
      shallowDirs(workspacePath, XCODE_SCAN_DEPTH).find(hasGradlew) ?? null
    );
  }

  private async buildIos(
    workspacePath: string,
    opts: { scheme?: string; configuration?: string }
  ): Promise<BuildResult> {
    const container = this.findXcodeContainer(workspacePath);
    if (container == null) {
      return {
        success: false,
        output:
          "No .xcworkspace or .xcodeproj found at the workspace root or ./ios. For Flutter/React Native, run the framework build via the shell instead.",
      };
    }
    let scheme = opts.scheme;
    if (scheme == null) {
      try {
        const { stdout } = await run(
          "/usr/bin/xcrun",
          ["xcodebuild", container.flag, container.path, "-list", "-json"],
          { timeoutMs: 60_000 }
        );
        const listed = JSON.parse(stdout) as {
          workspace?: { schemes?: string[] };
          project?: { schemes?: string[] };
        };
        const schemes =
          listed?.workspace?.schemes ?? listed?.project?.schemes ?? [];
        scheme = schemes[0];
      } catch (e) {
        // A failing `xcodebuild -list` needs its own phase context.
        const detail = e instanceof Error ? e.message : String(e);
        return {
          success: false,
          output: tail(`Could not list Xcode schemes.\n${detail}`),
        };
      }
      if (scheme == null)
        return {
          success: false,
          output: "Could not determine an Xcode scheme. Pass one explicitly.",
        };
    }
    const configuration = opts.configuration ?? "Debug";
    // No `-derivedDataPath`: Xcode's user-script sandbox only grants
    // run-script phases read access around the standard DerivedData, and the
    // default shares Xcode's cache.
    const settingArgs = [
      "xcodebuild",
      container.flag,
      container.path,
      "-scheme",
      scheme,
      "-configuration",
      configuration,
      "-destination",
      IOS_SIM_DESTINATION,
    ];
    const settings = await this.iosBuildSettings(settingArgs);
    try {
      const args = [...settingArgs, "build"];
      // Run from the project's own directory; run-script phases assume it.
      const { stdout, stderr } = await run("/usr/bin/xcrun", args, {
        cwd: path.dirname(container.path),
        timeoutMs: 900_000,
      });
      const productsDir = settings.productsDir;
      if (productsDir == null) {
        return {
          success: false,
          output: tail(
            `Build finished but the products directory could not be resolved from xcodebuild -showBuildSettings.\n${stderr}\n${stdout}`
          ),
        };
      }
      const app =
        settings.productName != null &&
        fs.existsSync(path.join(productsDir, settings.productName))
          ? settings.productName
          : fs.existsSync(productsDir)
            ? fs.readdirSync(productsDir).find((e) => e.endsWith(".app"))
            : undefined;
      if (app == null) {
        return {
          success: false,
          output: tail(
            `Build reported success but no .app found in ${productsDir}\n${stderr}\n${stdout}`
          ),
        };
      }
      const artifactPath = path.join(productsDir, app);
      let appId = settings.bundleId;
      if (appId == null) {
        try {
          const { stdout: bid } = await run("/usr/libexec/PlistBuddy", [
            "-c",
            "Print CFBundleIdentifier",
            path.join(artifactPath, "Info.plist"),
          ]);
          appId = bid.trim() || undefined;
        } catch {
          /* Info.plist variant: the agent can find it */
        }
      }
      return { success: true, artifactPath, appId, output: tail(stdout, 2000) };
    } catch (e) {
      return {
        success: false,
        output: tail(e instanceof Error ? e.message : String(e)),
      };
    }
  }

  /** Ask xcodebuild where the .app lands and its bundle id. `buildArgs` must
   *  match the build's flags: settings depend on destination/configuration. */
  private async iosBuildSettings(buildArgs: string[]): Promise<{
    productsDir?: string;
    productName?: string;
    bundleId?: string;
  }> {
    try {
      const { stdout } = await run(
        "/usr/bin/xcrun",
        [...buildArgs, "-showBuildSettings", "-json"],
        { timeoutMs: 180_000 }
      );
      // xcodebuild can print notes/warnings ahead of the JSON payload.
      const json = stdout.slice(stdout.indexOf("["));
      const entries = JSON.parse(json) as Array<{
        buildSettings?: Record<string, string>;
      }>;
      const all = entries.map((e) => e.buildSettings ?? {});
      const app =
        all.find(
          (s) => s.PRODUCT_TYPE === "com.apple.product-type.application"
        ) ??
        all[0] ??
        {};
      return {
        productsDir: app.BUILT_PRODUCTS_DIR,
        productName: app.FULL_PRODUCT_NAME,
        bundleId: app.PRODUCT_BUNDLE_IDENTIFIER,
      };
    } catch {
      return {};
    }
  }

  private async buildAndroid(workspacePath: string): Promise<BuildResult> {
    const root = this.findGradleRoot(workspacePath);
    if (root == null) {
      return {
        success: false,
        output:
          "No gradlew found at or below the workspace root. For Flutter/React Native, run the framework build via the shell instead.",
      };
    }
    const gradlew =
      process.platform === "win32"
        ? path.join(root, "gradlew.bat")
        : path.join(root, "gradlew");
    const jdk = this.resolveGradleJavaHome(root);
    // A GUI-launched app inherits no shell profile, so hand Gradle the SDK
    // already resolved for adb or AGP fails without ANDROID_HOME.
    const sdkRoot = findAndroidSdk();
    const env: Record<string, string> = {};
    if (jdk.home != null) env.JAVA_HOME = jdk.home;
    if (sdkRoot != null) {
      env.ANDROID_HOME = sdkRoot;
      env.ANDROID_SDK_ROOT = sdkRoot;
    }
    try {
      const { stdout } = await run(gradlew, ["assembleDebug"], {
        cwd: root,
        timeoutMs: 900_000,
        env,
      });
      const apk = this.findNewestApk(root);
      if (apk == null)
        return {
          success: false,
          output: tail(
            `Build reported success but no debug APK found under ${root}\n${stdout}`
          ),
        };
      return {
        success: true,
        artifactPath: apk,
        appId: this.readApplicationId(root),
        output: tail(stdout, 2000),
      };
    } catch (e) {
      return {
        success: false,
        output: tail(e instanceof Error ? e.message : String(e)),
      };
    }
  }

  /**
   * The project's own JDK wins: Android Studio records it in
   * `.gradle/config.properties` or `gradle.properties`, which `gradlew`
   * ignores in favour of JAVA_HOME, and a different JDK breaks its settings.
   */
  private resolveGradleJavaHome(root: string): {
    home?: string;
    source: string;
  } {
    const fromProps = (file: string, key: string): string | undefined => {
      try {
        for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
          const trimmed = line.trim();
          if (trimmed.startsWith("#") || !trimmed.startsWith(key)) continue;
          const value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
          // Java .properties escaping: paths arrive with `\:` and `\\`.
          const unescaped = value.replace(/\\:/g, ":").replace(/\\\\/g, "\\");
          if (unescaped !== "") return unescaped;
        }
      } catch {
        /* absent or unreadable */
      }
      return undefined;
    };
    const candidates: Array<{ home?: string; source: string }> = [
      {
        home: fromProps(
          path.join(root, ".gradle", "config.properties"),
          "java.home"
        ),
        source: "project .gradle/config.properties",
      },
      {
        home: fromProps(
          path.join(root, "gradle.properties"),
          "org.gradle.java.home"
        ),
        source: "project gradle.properties",
      },
      {
        home: fromProps(
          path.join(os.homedir(), ".gradle", "gradle.properties"),
          "org.gradle.java.home"
        ),
        source: "~/.gradle/gradle.properties",
      },
      { home: process.env.JAVA_HOME, source: "JAVA_HOME" },
    ];
    for (const candidate of candidates) {
      if (candidate.home == null || candidate.home === "") continue;
      if (!fs.existsSync(path.join(candidate.home, "bin", exeName("java")))) {
        continue;
      }
      return candidate;
    }
    const found = this.findJavaHome();
    return {
      home: found?.JAVA_HOME,
      source: found != null ? "detected JDK" : "none",
    };
  }

  /** A usable JDK for Gradle when nothing declares one (GUI launch has no JAVA_HOME). */
  private findJavaHome(): { JAVA_HOME: string } | undefined {
    const candidates =
      process.platform === "darwin"
        ? [
            "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
            path.join(os.homedir(), "Library/Java/JavaVirtualMachines"),
            "/Library/Java/JavaVirtualMachines",
            // Homebrew is how most Macs without Android Studio get a JDK.
            "/opt/homebrew/opt",
            "/usr/local/opt",
          ]
        : process.platform === "win32"
          ? ["C:\\Program Files\\Android\\Android Studio\\jbr"]
          : ["/opt/android-studio/jbr", "/usr/lib/jvm"];
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      if (fs.existsSync(path.join(candidate, "bin", exeName("java"))))
        return { JAVA_HOME: candidate };
      // A JVM *container* dir: rank what is inside it.
      try {
        const inner = fs
          .readdirSync(candidate)
          .map((entry) => path.join(candidate, entry))
          .flatMap((jvm) => [
            path.join(jvm, "Contents", "Home"),
            // Homebrew's layout: <opt>/openjdk@21/libexec/openjdk.jdk/Contents/Home
            path.join(jvm, "libexec", "openjdk.jdk", "Contents", "Home"),
            jvm,
          ])
          .filter((home) =>
            fs.existsSync(path.join(home, "bin", exeName("java")))
          )
          .map((home) => ({ home, version: jdkVersion(home) }));
        const best = pickGradleJdk(inner);
        if (best != null) return { JAVA_HOME: best.home };
      } catch {
        /* unreadable: next candidate */
      }
    }
    return undefined;
  }

  private findNewestApk(root: string): string | null {
    const results: Array<{ file: string; mtime: number }> = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (
          entry.name.endsWith(".apk") &&
          full.includes(`outputs${path.sep}apk`)
        ) {
          try {
            results.push({ file: full, mtime: fs.statSync(full).mtimeMs });
          } catch {
            /* raced */
          }
        }
      }
    };
    walk(root, 0);
    results.sort((a, b) => b.mtime - a.mtime);
    const debug = results.find((r) => r.file.includes("debug"));
    return debug?.file ?? results[0]?.file ?? null;
  }

  private readApplicationId(root: string): string | undefined {
    for (const rel of [
      "app/build.gradle",
      "app/build.gradle.kts",
      "build.gradle",
      "build.gradle.kts",
    ]) {
      try {
        const content = fs.readFileSync(path.join(root, rel), "utf-8");
        const m = content.match(/applicationId\s*[=(]?\s*["']([^"']+)["']/);
        if (m != null) return m[1];
      } catch {
        /* next candidate */
      }
    }
    return undefined;
  }

  // --- App lifecycle ---

  async installApp(
    platform: DevicePlatform,
    artifactPath: string,
    idOrName?: string
  ): Promise<DeviceInfo> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run(
        "/usr/bin/xcrun",
        ["simctl", "install", device.id, artifactPath],
        {
          timeoutMs: 120_000,
        }
      );
    } else {
      try {
        await run(
          this.adb(),
          ["-s", device.id, "install", "-r", artifactPath],
          {
            timeoutMs: 180_000,
          }
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        // A dropped transport leaves nothing after the colon; find the reason.
        let state = "unknown";
        try {
          const { stdout } = await run(
            this.adb(),
            ["-s", device.id, "get-state"],
            {
              timeoutMs: 10_000,
            }
          );
          state = stdout.trim() || "unknown";
        } catch {
          state = "unreachable";
        }
        throw new Error(`${detail}\n(device state: ${state})`);
      }
    }
    return device;
  }

  async launchApp(
    platform: DevicePlatform,
    appId: string,
    idOrName?: string
  ): Promise<DeviceInfo> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run("/usr/bin/xcrun", ["simctl", "launch", device.id, appId], {
        timeoutMs: 60_000,
      });
    } else {
      // monkey exits 0 even when it launched nothing ("No activities found"),
      // so the output is the only evidence the app actually came up.
      const { stdout, stderr } = await run(
        this.adb(),
        [
          "-s",
          device.id,
          "shell",
          "monkey",
          "-p",
          appId,
          "-c",
          "android.intent.category.LAUNCHER",
          "1",
        ],
        { timeoutMs: 30_000 }
      );
      const combined = `${stdout}\n${stderr}`.trim();
      if (/No activities found|Error:/i.test(combined)) {
        throw new Error(
          `The app installed but did not launch: ${tail(combined, 500)}`
        );
      }
    }
    return device;
  }

  async terminateApp(
    platform: DevicePlatform,
    appId: string,
    idOrName?: string
  ): Promise<void> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run("/usr/bin/xcrun", ["simctl", "terminate", device.id, appId]);
    } else {
      await run(this.adb(), [
        "-s",
        device.id,
        "shell",
        "am",
        "force-stop",
        appId,
      ]);
    }
  }

  async uninstallApp(
    platform: DevicePlatform,
    appId: string,
    idOrName?: string
  ): Promise<void> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run("/usr/bin/xcrun", ["simctl", "uninstall", device.id, appId]);
    } else {
      await run(this.adb(), ["-s", device.id, "uninstall", appId]);
    }
  }

  async openUrl(
    platform: DevicePlatform,
    url: string,
    idOrName?: string
  ): Promise<void> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      await run("/usr/bin/xcrun", ["simctl", "openurl", device.id, url]);
    } else {
      await run(this.adb(), [
        "-s",
        device.id,
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url,
      ]);
    }
  }

  // --- Observation ---

  async screenshot(
    platform: DevicePlatform,
    idOrName?: string
  ): Promise<{ file: string; note: string }> {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const file = path.join(TEMP_DIR, `device-${platform}-${Date.now()}.png`);
    const buffer = await this.screenshotBuffer(platform, idOrName);
    fs.writeFileSync(file, buffer);
    // An iOS PNG is 2-3x the point space interact/snapshot use.
    const pixels = readPngSize(buffer);
    let note = "";
    if (pixels != null) {
      note = `\nImage is ${pixels.width}x${pixels.height} pixels.`;
      const device =
        platform === "ios"
          ? await this.resolveTarget(platform, idOrName).catch(() => null)
          : null;
      const points =
        device != null ? this.iosScreenPoints.get(device.id) : undefined;
      if (points != null && points.w > 0) {
        const scale = Math.round(pixels.width / points.w);
        note +=
          ` The screen is ${points.w}x${points.h} points (${scale}x). device_interact coordinates are in POINTS,` +
          " so divide any pixel coordinate read off this image by the scale, or use an @eN ref from device_snapshot.";
      } else if (platform === "ios") {
        note +=
          " device_interact coordinates are in POINTS, which on iOS are 2-3x smaller than these pixels;" +
          " take a device_snapshot and use @eN refs instead of reading coordinates off the image.";
      }
    }
    return { file, note };
  }

  /** For the mirror panel; no temp-file litter. */
  async screenshotBuffer(
    platform: DevicePlatform,
    idOrName?: string
  ): Promise<Buffer> {
    const device = await this.resolveTarget(platform, idOrName);
    if (platform === "ios") {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
      const tmp = path.join(TEMP_DIR, `.shot-${process.pid}-${Date.now()}.png`);
      try {
        await run(
          "/usr/bin/xcrun",
          ["simctl", "io", device.id, "screenshot", tmp],
          {
            timeoutMs: 30_000,
          }
        );
        return fs.readFileSync(tmp);
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* already gone */
        }
      }
    }
    const { buffer } = await run(
      this.adb(),
      ["-s", device.id, "exec-out", "screencap", "-p"],
      {
        binary: true,
        timeoutMs: 30_000,
      }
    );
    if (buffer == null || buffer.length === 0)
      throw new Error("screencap returned no data");
    return buffer;
  }

  async logs(
    platform: DevicePlatform,
    opts: {
      lines?: number;
      filter?: string;
      appId?: string;
      deviceId?: string;
    } = {}
  ): Promise<string> {
    const device = await this.resolveTarget(platform, opts.deviceId);
    const lines = Math.min(Math.max(opts.lines ?? 200, 10), 2000);
    let raw: string;
    if (platform === "ios") {
      const args = [
        "simctl",
        "spawn",
        device.id,
        "log",
        "show",
        "--style",
        "compact",
        "--last",
        "2m",
      ];
      const appId = opts.appId?.trim().replace(/"/g, "") ?? "";
      if (appId !== "") {
        // `processImagePath` is the executable, conventionally the bundle
        // id's last component; os_log subsystems are the id. Match either.
        const process = appId.split(".").pop() ?? appId;
        args.push(
          "--predicate",
          `processImagePath CONTAINS[c] "${process}" OR subsystem CONTAINS[c] "${appId}"`
        );
      }
      raw = (await run("/usr/bin/xcrun", args, { timeoutMs: 60_000 })).stdout;
    } else {
      raw = (
        await run(
          this.adb(),
          ["-s", device.id, "logcat", "-d", "-t", String(lines * 3)],
          {
            timeoutMs: 30_000,
          }
        )
      ).stdout;
    }
    let logLines = raw.split("\n");
    if (opts.filter != null && opts.filter.trim() !== "") {
      logLines = await filterLogLines(logLines, opts.filter);
    }
    return logLines.slice(-lines).join("\n");
  }

  // --- Snapshot + interaction (Android: adb/uiautomator; iOS: Maestro) ---

  async snapshot(platform: DevicePlatform, idOrName?: string): Promise<string> {
    if (platform === "ios") return this.snapshotIos(idOrName);
    return this.snapshotAndroid(idOrName);
  }

  async interact(
    platform: DevicePlatform,
    args: InteractArgs
  ): Promise<string> {
    if (platform === "ios") return this.interactIos(args);
    return this.interactAndroid(args);
  }

  private requireMaestro(): string {
    const maestro = this.getMaestroPath();
    if (maestro == null) {
      throw new Error(
        "iOS snapshot/interaction requires Maestro, which is not installed. " +
          'Install it with: curl -Ls "https://get.maestro.mobile.dev" | bash. ' +
          "Meanwhile, use device_screenshot to see the screen and deep links (device_app open_url) to navigate."
      );
    }
    return maestro;
  }

  private async snapshotIos(idOrName?: string): Promise<string> {
    const maestro = this.requireMaestro();
    const device = await this.resolveTarget("ios", idOrName);
    const { stdout } = await run(
      maestro,
      ["--device", device.id, "hierarchy"],
      {
        timeoutMs: 120_000,
        env: MAESTRO_ENV,
      }
    );
    const json = extractJsonObject(stdout);
    if (json == null)
      throw new Error(
        `maestro hierarchy returned no JSON:\n${tail(stdout, 1000)}`
      );
    let root: MaestroNode;
    try {
      root = JSON.parse(json) as MaestroNode;
    } catch {
      throw new Error(
        `Could not parse maestro hierarchy output:\n${tail(stdout, 1000)}`
      );
    }
    this.refMap.clear();
    const lines: string[] = [];
    let refCounter = 0;
    let maxX = 0;
    let maxY = 0;
    // Screen size comes from the shallowest node with real bounds, not the
    // max over every node: scrollable content is taller than the viewport.
    let windowDepth: number | null = null;
    let winW = 0;
    let winH = 0;
    type Pending = {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      label: string;
      resourceId: string;
      interactive: boolean;
    };
    const pending: Pending[] = [];
    const walk = (node: MaestroNode, depth: number): void => {
      const attrs = node?.attributes ?? {};
      // First non-empty, not first non-nullish: Maestro emits every attribute
      // on every iOS node as "", so `??` would stop at an empty `text`.
      const label = firstNonEmpty(
        attrs.text,
        attrs.accessibilityText,
        attrs.title,
        attrs.value,
        attrs.hintText
      );
      const resourceId = firstNonEmpty(attrs["resource-id"], attrs.resourceId);
      const bounds = (attrs.bounds ?? "").match(
        /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/
      );
      if (bounds != null) {
        const bx2 = Number(bounds[3]);
        const by2 = Number(bounds[4]);
        maxX = Math.max(maxX, bx2);
        maxY = Math.max(maxY, by2);
        if (
          bx2 > 0 &&
          by2 > 0 &&
          (windowDepth == null || depth === windowDepth)
        ) {
          windowDepth = depth;
          winW = Math.max(winW, bx2);
          winH = Math.max(winH, by2);
        }
      }
      const x1 = bounds != null ? Number(bounds[1]) : 0;
      const y1 = bounds != null ? Number(bounds[2]) : 0;
      const x2 = bounds != null ? Number(bounds[3]) : 0;
      const y2 = bounds != null ? Number(bounds[4]) : 0;
      // iOS has no `clickable`; anything identifiable is offered as a ref and
      // `enabled=false` is the only signal it can't be interacted with.
      const identifiable = label !== "" || resourceId !== "";
      const hasArea = bounds != null && x2 > x1 && y2 > y1;
      if (hasArea && (identifiable || label !== "")) {
        pending.push({
          x1,
          y1,
          x2,
          y2,
          label,
          resourceId,
          interactive: identifiable && attrs.enabled !== "false",
        });
      }
      for (const child of node?.children ?? []) walk(child, depth + 1);
    };
    walk(root, 0);
    const screenW = winW > 0 ? winW : maxX;
    const screenH = winH > 0 ? winH : maxY;
    for (const item of pending) {
      const cx = Math.round((item.x1 + item.x2) / 2);
      const cy = Math.round((item.y1 + item.y2) / 2);
      // A centre outside the viewport is a ref that taps a dead spot.
      const visible = cx >= 0 && cy >= 0 && cx <= screenW && cy <= screenH;
      if (item.interactive && visible) {
        const ref = `@e${++refCounter}`;
        this.refMap.set(ref, { deviceId: device.id, x: cx, y: cy });
        const idPart = item.resourceId !== "" ? ` id=${item.resourceId}` : "";
        lines.push(`${ref}${idPart} "${item.label}"`);
      } else if (!visible && item.label !== "") {
        lines.push(`(offscreen, scroll to reach) "${item.label}"`);
      } else if (item.label !== "") {
        lines.push(`(text) "${item.label}"`);
      }
    }
    if (screenW > 0 && screenH > 0)
      this.iosScreenPoints.set(device.id, { w: screenW, h: screenH });
    if (lines.length === 0) {
      return "No elements found in the view hierarchy. Use device_screenshot to inspect the screen visually.";
    }
    return `Interactive elements (@eN refs are tappable via device_interact; refs valid until the next snapshot):\n${lines.join("\n")}`;
  }

  /** iOS interaction via the native HID helper. Null means "fall back to
   *  Maestro" (typing, unmapped keys, coordinates we can't normalize). */
  private async tryNativeIosInteract(
    deviceId: string,
    args: InteractArgs
  ): Promise<string | null> {
    switch (args.action) {
      case "tap": {
        const p = this.iosFraction(deviceId, args);
        if (p == null) return null;
        return (await this.simInput.tap(deviceId, p.nx, p.ny))
          ? `Tapped.${p.note ?? ""}`
          : null;
      }
      case "long_press": {
        const p = this.iosFraction(deviceId, args);
        if (p == null) return null;
        return (await this.simInput.longPress(deviceId, p.nx, p.ny))
          ? `Long-pressed.${p.note ?? ""}`
          : null;
      }
      case "swipe":
      case "scroll": {
        // "scroll down" moves the finger up, as on Android/Maestro.
        const half = 0.3;
        const down: [number, number, number, number] = [
          0.5,
          0.5 + half,
          0.5,
          0.5 - half,
        ];
        const vectors = new Map<string, [number, number, number, number]>([
          ["down", down],
          ["up", [0.5, 0.5 - half, 0.5, 0.5 + half]],
          ["left", [0.5 + half, 0.5, 0.5 - half, 0.5]],
          ["right", [0.5 - half, 0.5, 0.5 + half, 0.5]],
        ]);
        const v = vectors.get(args.direction ?? "down") ?? down;
        return (await this.simInput.swipe(deviceId, v[0], v[1], v[2], v[3]))
          ? `Scrolled ${args.direction ?? "down"}.`
          : null;
      }
      case "press_key": {
        // Only hardware buttons go native; text keys (enter/delete) need Maestro.
        const key = (args.key ?? "").toLowerCase();
        const buttonMap: Record<string, "home" | "lock" | "siri"> = {
          home: "home",
          lock: "lock",
          siri: "siri",
        };
        const button = buttonMap[key];
        if (button == null) return null;
        return (await this.simInput.button(deviceId, button))
          ? `Pressed ${button}.`
          : null;
      }
      default:
        return null; // type / wait / anything else → Maestro
    }
  }

  /**
   * Point-space coordinate for the args, or null when none were supplied.
   * Shared by both iOS backends so the pixel/point guard covers Maestro too,
   * the common path on installs without the native helper.
   */
  private iosPoint(
    deviceId: string,
    args: InteractArgs
  ): { x: number; y: number; note?: string } | null {
    const screen = this.iosScreenPoints.get(deviceId);
    if (args.ref != null) {
      const entry = this.refMap.get(args.ref);
      if (entry == null)
        throw new Error(
          `Unknown ref ${args.ref}. Take a new device_snapshot first.`
        );
      if (entry.deviceId !== deviceId)
        throw new Error(
          `Ref ${args.ref} belongs to another device. Take a new device_snapshot.`
        );
      return { x: entry.x, y: entry.y };
    }
    if (args.x == null || args.y == null) return null;
    if (args.x <= 1 && args.y <= 1 && screen != null) {
      return { x: args.x * screen.w, y: args.y * screen.h };
    }
    if (screen == null) return { x: args.x, y: args.y };
    let { x, y } = args;
    let note: string | undefined;
    if (x > screen.w || y > screen.h) {
      // A screenshot is 2-3x the point space, so coordinates read off the PNG
      // land off-screen. Convert when they are clearly pixels; otherwise fail
      // loudly rather than report "Tapped." for a tap that went nowhere.
      const scale = [3, 2].find((s) => x / s <= screen.w && y / s <= screen.h);
      if (scale == null) {
        throw new Error(
          `(${x}, ${y}) is outside the ${screen.w}x${screen.h} screen. device_snapshot bounds and device_interact ` +
            "coordinates are in POINTS; a device_screenshot PNG is 2-3x larger in pixels. Prefer an @eN ref from device_snapshot."
        );
      }
      x /= scale;
      y /= scale;
      note = ` (read (${args.x}, ${args.y}) as screenshot pixels → (${Math.round(x)}, ${Math.round(y)}) points)`;
    }
    return { x, y, note };
  }

  /** Normalized (0..1) for the native HID helper; null when unavailable. */
  private iosFraction(
    deviceId: string,
    args: InteractArgs
  ): { nx: number; ny: number; note?: string } | null {
    const screen = this.iosScreenPoints.get(deviceId);
    if (
      args.ref == null &&
      args.x != null &&
      args.y != null &&
      args.x <= 1 &&
      args.y <= 1
    ) {
      return { nx: args.x, ny: args.y };
    }
    const point = this.iosPoint(deviceId, args);
    if (point == null || screen == null) return null;
    return { nx: point.x / screen.w, ny: point.y / screen.h, note: point.note };
  }

  private async interactIos(args: InteractArgs): Promise<string> {
    const device = await this.resolveTarget("ios", args.deviceId);

    // ── Native HID fast path (sub-10ms, no Maestro round-trip) ──────────────
    if (this.simInput.isSupported()) {
      const native = await this.tryNativeIosInteract(device.id, args);
      if (native != null) return native;
    }

    // ── Maestro fallback (typing, unknown-coordinate taps, when no helper) ──
    const maestro = this.requireMaestro();
    let pointNote = "";
    const point = (): string => {
      // Maestro accepts percentages without our knowing the screen size.
      if (
        args.ref == null &&
        args.x != null &&
        args.y != null &&
        args.x <= 1 &&
        args.y <= 1
      ) {
        return `${Math.round(args.x * 100)}%,${Math.round(args.y * 100)}%`;
      }
      const resolved = this.iosPoint(device.id, args);
      if (resolved == null)
        throw new Error(
          "Pass a ref from device_snapshot or explicit x/y coordinates."
        );
      pointNote = resolved.note ?? "";
      return `${Math.round(resolved.x)},${Math.round(resolved.y)}`;
    };

    let step: string;
    switch (args.action) {
      case "tap": {
        step = `- tapOn:\n    point: "${point()}"`;
        break;
      }
      case "long_press": {
        step = `- longPressOn:\n    point: "${point()}"`;
        break;
      }
      case "swipe":
      case "scroll": {
        const dirMap = new Map<string, string>([
          ["up", "DOWN"],
          ["down", "UP"],
          ["left", "RIGHT"],
          ["right", "LEFT"],
        ]);
        // Maestro's direction is the finger's: "scroll down" swipes UP.
        step = `- swipe:\n    direction: ${dirMap.get(args.direction ?? "down") ?? "UP"}`;
        break;
      }
      case "type": {
        if (args.text == null) throw new Error("type requires text.");
        step = `- inputText: ${JSON.stringify(args.text)}`;
        break;
      }
      case "press_key": {
        const keyMap = new Map<string, string>([
          ["enter", "Enter"],
          ["home", "Home"],
          ["delete", "Backspace"],
          ["back", "Back"],
        ]);
        const key = keyMap.get((args.key ?? "").toLowerCase());
        if (key == null)
          throw new Error(
            `Unknown key "${args.key}". iOS supports: enter, home, delete.`
          );
        step = `- pressKey: ${key}`;
        break;
      }
      case "wait": {
        const ms = Math.min(Math.max(args.amount ?? 2000, 100), 15_000);
        await new Promise((r) => setTimeout(r, ms));
        return `Waited ${ms}ms.`;
      }
      default:
        throw new Error(`Unknown action "${args.action}".`);
    }

    fs.mkdirSync(TEMP_DIR, { recursive: true });
    const flowFile = path.join(
      TEMP_DIR,
      `.flow-${process.pid}-${Date.now()}.yaml`
    );
    // A flow file requires an appId header; it is not validated against the
    // foreground app when no launchApp step is present.
    fs.writeFileSync(flowFile, `appId: interact.step\n---\n${step}\n`);
    try {
      await run(maestro, ["--device", device.id, "test", flowFile], {
        timeoutMs: 180_000,
        env: MAESTRO_ENV,
      });
    } finally {
      try {
        fs.unlinkSync(flowFile);
      } catch {
        /* already gone */
      }
    }
    return `Performed ${args.action}.${pointNote} Take a device_screenshot or device_snapshot to see the result.`;
  }

  async snapshotAndroid(idOrName?: string): Promise<string> {
    const device = await this.resolveTarget("android", idOrName);
    const { stdout } = await run(
      this.adb(),
      ["-s", device.id, "exec-out", "uiautomator", "dump", "/dev/tty"],
      { timeoutMs: 30_000 }
    );
    const xml = stdout.slice(stdout.indexOf("<?xml"));
    this.refMap.clear();
    const { lines, points } = renderAndroidSnapshot(xml);
    points.forEach((p, i) =>
      this.refMap.set(`@e${i + 1}`, { deviceId: device.id, x: p.x, y: p.y })
    );
    if (lines.length === 0) {
      return "No elements found in the UI hierarchy. The screen may be rendering with a game/canvas surface. Use device_screenshot instead.";
    }
    return `Interactive elements (@eN refs are tappable via device_interact; refs valid until the next snapshot):\n${lines.join("\n")}`;
  }

  async interactAndroid(args: InteractArgs): Promise<string> {
    const device = await this.resolveTarget("android", args.deviceId);
    const point = (): { x: number; y: number } => {
      if (args.ref != null) {
        const entry = this.refMap.get(args.ref);
        if (entry == null)
          throw new Error(
            `Unknown ref ${args.ref}. Take a new device_snapshot first.`
          );
        if (entry.deviceId !== device.id)
          throw new Error(
            `Ref ${args.ref} belongs to another device. Take a new device_snapshot.`
          );
        return { x: entry.x, y: entry.y };
      }
      if (args.x != null && args.y != null) return { x: args.x, y: args.y };
      throw new Error(
        "Pass a ref from device_snapshot or explicit x/y coordinates."
      );
    };
    const input = this.androidInput;

    switch (args.action) {
      case "tap": {
        const p = point();
        input.tap(device.id, p.x, p.y);
        return `Tapped (${p.x}, ${p.y}).`;
      }
      case "long_press": {
        const p = point();
        input.longPress(device.id, p.x, p.y);
        return `Long-pressed (${p.x}, ${p.y}).`;
      }
      case "swipe":
      case "scroll": {
        const distance = Math.min(Math.max(args.amount ?? 500, 50), 2000);
        const { w, h } = await this.androidScreenSize(device.id);
        const cx = Math.round(w / 2);
        const cy = Math.round(h / 2);
        const half = Math.round(distance / 2);
        // "scroll down" = reveal content below = finger moves up
        const down: [number, number, number, number] = [
          cx,
          cy + half,
          cx,
          cy - half,
        ];
        const vectors = new Map<string, [number, number, number, number]>([
          ["down", down],
          ["up", [cx, cy - half, cx, cy + half]],
          ["left", [cx + half, cy, cx - half, cy]],
          ["right", [cx - half, cy, cx + half, cy]],
        ]);
        const v = vectors.get(args.direction ?? "down") ?? down;
        input.swipe(device.id, v[0], v[1], v[2], v[3]);
        return `Scrolled ${args.direction ?? "down"} by ${distance}px.`;
      }
      case "type": {
        if (args.text == null) throw new Error("type requires text.");
        const typed = typableText(args.text);
        if (typed === "" || !input.text(device.id, args.text)) {
          throw new Error(
            "Nothing was typed: the text has no characters a device keyboard can enter."
          );
        }
        return `Typed ${typed.length} characters.`;
      }
      case "press_key": {
        const key = args.key?.trim() ?? "";
        if (!input.keyEvent(device.id, key)) {
          throw new Error(
            `Unknown key "${key}". Use enter/back/home/tab/delete/menu/recents/volume_up/volume_down, or a raw KEYCODE_* value.`
          );
        }
        return `Pressed ${key}.`;
      }
      case "wait": {
        const ms = Math.min(Math.max(args.amount ?? 2000, 100), 15_000);
        await new Promise((r) => setTimeout(r, ms));
        return `Waited ${ms}ms.`;
      }
      default:
        throw new Error(`Unknown action "${args.action}".`);
    }
  }

  private async androidScreenSize(
    serial: string
  ): Promise<{ w: number; h: number }> {
    const cached = this.androidScreen.get(serial);
    if (cached != null) return cached;
    let w = 1080;
    let h = 1920;
    try {
      const { stdout } = await run(
        this.adb(),
        ["-s", serial, "shell", "wm", "size"],
        {
          timeoutMs: 10_000,
        }
      );
      const size =
        stdout.match(/Physical size:\s*(\d+)x(\d+)/) ??
        stdout.match(/(\d+)x(\d+)/);
      if (size != null) {
        w = Number(size[1]);
        h = Number(size[2]);
      }
    } catch {
      /* defaults */
    }
    const value = { w, h };
    this.androidScreen.set(serial, value);
    return value;
  }

  /** Absolute px. A streamed drag needs sendevent, so only up becomes a tap. */
  androidTap(serial: string, x: number, y: number): boolean {
    return this.androidInput.tap(serial, x, y);
  }

  androidSwipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): boolean {
    return this.androidInput.swipe(serial, x1, y1, x2, y2);
  }

  disposeAndroidInput(serial: string): void {
    this.androidInput.disposeDevice(serial);
  }
}
