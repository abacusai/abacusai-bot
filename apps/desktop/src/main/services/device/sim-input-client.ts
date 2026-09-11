import { spawn, execFile, type ChildProcessByStdio } from "child_process";
import fs from "fs";
import path from "path";
import type { Readable, Writable } from "stream";

import { app } from "electron";

/**
 * Persistent connection to the native `sim-input` helper, one per booted iOS
 * simulator UDID, which synthesizes HID events through SimulatorKit and reads
 * newline-delimited JSON on stdin. Coordinates are normalized (0..1,
 * top-left origin); the helper writes them straight into the digitizer ratio.
 */

interface HelperCommand {
  cmd: "touch" | "button" | "ping" | "keypress" | "text";
  phase?: "down" | "move" | "up";
  x?: number;
  y?: number;
  name?: string;
  usage?: number;
  text?: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface KeyModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

const HELPER_READY_TIMEOUT_MS = 8000;

export const resolveSimInputHelperPath = (): string => {
  if (process.env.SIM_INPUT_HELPER_PATH != null)
    return process.env.SIM_INPUT_HELPER_PATH;
  return app.isPackaged
    ? path.join(process.resourcesPath, "native", "sim-input")
    : path.join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "main",
        "native",
        "sim-input",
        ".build",
        "release",
        "sim-input"
      );
};

/** Resolves the active Xcode developer dir (xcode-select -p), cached. */
let cachedDeveloperDir: string | null | undefined;
export const resolveSimulatorDeveloperDir = async (): Promise<
  string | null
> => {
  if (cachedDeveloperDir !== undefined) return cachedDeveloperDir;
  cachedDeveloperDir = await new Promise<string | null>((resolve) => {
    execFile(
      "/usr/bin/xcode-select",
      ["-p"],
      { timeout: 5000 },
      (err, stdout) => {
        resolve(err != null ? null : stdout.trim());
      }
    );
  });
  return cachedDeveloperDir;
};

const resolveHelperPath = resolveSimInputHelperPath;

/**
 * Once per launch, drop the `com.apple.quarantine` xattr from the dev helper:
 * Gatekeeper refuses a quarantined ad-hoc-signed binary, and git GUIs can
 * re-quarantine it between builds. Packaged builds are notarized.
 */
let dequarantined = false;
export const ensureHelperRunnable = (): void => {
  if (dequarantined || process.platform !== "darwin" || app.isPackaged) return;
  dequarantined = true;
  const bin = resolveHelperPath();
  if (!fs.existsSync(bin)) return;
  execFile("/usr/bin/xattr", ["-d", "com.apple.quarantine", bin], () => {
    /* absent xattr → non-fatal */
  });
};

class SimInputConnection {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private ready = false;
  private stdoutBuffer = "";
  /** FIFO; the helper answers one line per command. */
  private pending: Array<{
    resolve: (ok: boolean) => void;
    reject: (e: Error) => void;
  }> = [];
  private readyWaiters: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
  }> = [];

  constructor(
    private readonly udid: string,
    private readonly developerDir: string,
    private readonly helperPath: string
  ) {}

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let obj: { ready?: boolean; ok?: boolean; error?: string };
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.ready === true) {
      this.ready = true;
      this.readyWaiters.splice(0).forEach((w) => w.resolve());
      return;
    }
    const waiter = this.pending.shift();
    if (waiter != null) {
      if (obj.ok === true) waiter.resolve(true);
      else waiter.resolve(false); // a failed send is non-fatal; caller can fall back
    }
  }

  private ensureStarted(): void {
    if (this.proc != null) return;
    ensureHelperRunnable();
    const proc = spawn(this.helperPath, [this.udid, this.developerDir], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      let nl: number;
      while ((nl = this.stdoutBuffer.indexOf("\n")) >= 0) {
        const line = this.stdoutBuffer.slice(0, nl);
        this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
        this.handleLine(line);
      }
    });
    proc.on("exit", () => {
      this.proc = null;
      this.ready = false;
      const err = new Error("sim-input helper exited");
      this.pending.splice(0).forEach((w) => w.reject(err));
      this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    });
    proc.on("error", (err) => {
      this.proc = null;
      this.ready = false;
      this.pending.splice(0).forEach((w) => w.reject(err));
      this.readyWaiters.splice(0).forEach((w) => w.reject(err));
    });
  }

  private async waitReady(): Promise<void> {
    this.ensureStarted();
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("sim-input helper did not become ready")),
        HELPER_READY_TIMEOUT_MS
      );
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  async send(cmd: HelperCommand): Promise<boolean> {
    await this.waitReady();
    const proc = this.proc;
    if (proc == null) throw new Error("sim-input helper not running");
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      proc.stdin.write(`${JSON.stringify(cmd)}\n`, (err) => {
        if (err != null) {
          const idx = this.pending.findIndex((p) => p.resolve === resolve);
          if (idx >= 0) this.pending.splice(idx, 1);
          reject(err);
        }
      });
    });
  }

  dispose(): void {
    if (this.proc != null) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

export class SimInputClient {
  private readonly connections = new Map<string, SimInputConnection>();
  private developerDir: string | null | undefined = undefined;
  private available: boolean | undefined = undefined;

  /** macOS-arm64 only, built via `build:sim-input`. */
  isSupported(): boolean {
    if (this.available === undefined) {
      this.available =
        process.platform === "darwin" && fs.existsSync(resolveHelperPath());
    }
    return this.available;
  }

  private async getDeveloperDir(): Promise<string | null> {
    if (this.developerDir !== undefined) return this.developerDir;
    this.developerDir = await new Promise<string | null>((resolve) => {
      execFile(
        "/usr/bin/xcode-select",
        ["-p"],
        { timeout: 5000 },
        (err, stdout) => {
          resolve(err != null ? null : stdout.trim());
        }
      );
    });
    return this.developerDir;
  }

  private async connection(udid: string): Promise<SimInputConnection | null> {
    if (!this.isSupported()) return null;
    const developerDir = await this.getDeveloperDir();
    if (developerDir == null) return null;
    let conn = this.connections.get(udid);
    if (conn == null) {
      conn = new SimInputConnection(udid, developerDir, resolveHelperPath());
      this.connections.set(udid, conn);
    }
    return conn;
  }

  /** False when the helper is unavailable or failed. */
  async tap(udid: string, nx: number, ny: number): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      const down = await conn.send({
        cmd: "touch",
        phase: "down",
        x: nx,
        y: ny,
      });
      const up = await conn.send({ cmd: "touch", phase: "up", x: nx, y: ny });
      return down && up;
    } catch {
      return false;
    }
  }

  async longPress(
    udid: string,
    nx: number,
    ny: number,
    holdMs = 600
  ): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      await conn.send({ cmd: "touch", phase: "down", x: nx, y: ny });
      await new Promise((r) => setTimeout(r, holdMs));
      await conn.send({ cmd: "touch", phase: "up", x: nx, y: ny });
      return true;
    } catch {
      return false;
    }
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    steps = 12
  ): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      await conn.send({ cmd: "touch", phase: "down", x: x1, y: y1 });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await conn.send({
          cmd: "touch",
          phase: "move",
          x: x1 + (x2 - x1) * t,
          y: y1 + (y2 - y1) * t,
        });
      }
      await conn.send({ cmd: "touch", phase: "up", x: x2, y: y2 });
      return true;
    } catch {
      return false;
    }
  }

  async touch(
    udid: string,
    phase: "down" | "move" | "up",
    nx: number,
    ny: number
  ): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      return await conn.send({ cmd: "touch", phase, x: nx, y: ny });
    } catch {
      return false;
    }
  }

  /** USB HID usage (page 0x07); the sim applies its own keyboard layout. */
  async keyPress(
    udid: string,
    usage: number,
    mods: KeyModifiers = {}
  ): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      return await conn.send({ cmd: "keypress", usage, ...mods });
    } catch {
      return false;
    }
  }

  /** US-layout HID; prefer keyPress for a live keyboard. */
  async typeText(udid: string, text: string): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      return await conn.send({ cmd: "text", text });
    } catch {
      return false;
    }
  }

  async button(
    udid: string,
    name: "home" | "lock" | "side_button" | "siri"
  ): Promise<boolean> {
    const conn = await this.connection(udid);
    if (conn == null) return false;
    try {
      await conn.send({ cmd: "button", name, phase: "down" });
      await conn.send({ cmd: "button", name, phase: "up" });
      return true;
    } catch {
      return false;
    }
  }

  disposeDevice(udid: string): void {
    this.connections.get(udid)?.dispose();
    this.connections.delete(udid);
  }

  dispose(): void {
    for (const conn of this.connections.values()) conn.dispose();
    this.connections.clear();
  }
}
