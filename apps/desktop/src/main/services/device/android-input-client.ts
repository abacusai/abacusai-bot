import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable, Writable } from "stream";

/**
 * Persistent `adb shell` per Android device: one open shell amortizes the
 * transport setup a fresh `adb shell input tap` pays every call. Values come
 * from the model or renderer, so each is single-quoted or matched against a
 * fixed shape, and `write` refuses anything spanning more than one line.
 */

/** Sink for device shell command lines. Swapped out in tests. */
export interface DeviceShell {
  write(line: string): void;
  dispose(): void;
}

/** Control characters cannot be typed, and a newline would end the command. */
export function typableText(value: string): string {
  return [...value].filter((c) => c >= " " && c !== "\u007f").join("");
}

/** POSIX single-quoting: the only form with no escape sequences inside it. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class AndroidShell implements DeviceShell {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;

  constructor(
    private readonly adbPath: string,
    private readonly serial: string
  ) {}

  private ensure(): ChildProcessByStdio<Writable, Readable, Readable> {
    if (this.proc != null) return this.proc;
    const proc = spawn(this.adbPath, ["-s", this.serial, "shell"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain stdout/stderr so the pipes never fill and block the shell.
    proc.stdout.resume();
    proc.stderr.resume();
    proc.on("exit", () => {
      if (this.proc === proc) this.proc = null;
    });
    proc.on("error", () => {
      if (this.proc === proc) this.proc = null;
    });
    // The ChildProcess 'error' does not cover stdin: an EPIPE from a device
    // unplugged mid-drag is a stream error and, unhandled, kills the process.
    proc.stdin.on("error", () => {
      if (this.proc === proc) this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  write(line: string): void {
    // A command line that can become two lines is a second command.
    if (/[\r\n]/.test(line)) {
      throw new Error("device shell command must be a single line");
    }
    const proc = this.ensure();
    proc.stdin.write(`${line}\n`);
  }

  dispose(): void {
    if (this.proc != null) {
      try {
        this.proc.stdin.write("exit\n");
      } catch {
        /* ignore */
      }
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

const KEYCODE_MAP = new Map<string, string>([
  ["enter", "KEYCODE_ENTER"],
  ["back", "KEYCODE_BACK"],
  ["home", "KEYCODE_HOME"],
  ["tab", "KEYCODE_TAB"],
  ["delete", "KEYCODE_DEL"],
  ["menu", "KEYCODE_MENU"],
  ["recents", "KEYCODE_APP_SWITCH"],
  ["volume_up", "KEYCODE_VOLUME_UP"],
  ["volume_down", "KEYCODE_VOLUME_DOWN"],
]);

/** The only shape a keycode may have on a command line. */
const RAW_KEYCODE = /^KEYCODE_[A-Z0-9_]{1,48}$/;

export class AndroidInputClient {
  private readonly shells = new Map<string, DeviceShell>();

  constructor(
    private readonly resolveAdb: () => string | null,
    private readonly openShell: (
      adbPath: string,
      serial: string
    ) => DeviceShell = (adbPath, serial) => new AndroidShell(adbPath, serial)
  ) {}

  private shell(serial: string): DeviceShell | null {
    const adbPath = this.resolveAdb();
    if (adbPath == null) return null;
    let s = this.shells.get(serial);
    if (s == null) {
      s = this.openShell(adbPath, serial);
      this.shells.set(serial, s);
    }
    return s;
  }

  tap(serial: string, x: number, y: number): boolean {
    const s = this.shell(serial);
    if (s == null) return false;
    s.write(`input tap ${Math.round(x)} ${Math.round(y)}`);
    return true;
  }

  longPress(serial: string, x: number, y: number, holdMs = 650): boolean {
    const s = this.shell(serial);
    if (s == null) return false;
    s.write(
      `input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y)} ${Math.round(holdMs)}`
    );
    return true;
  }

  swipe(
    serial: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs = 300
  ): boolean {
    const s = this.shell(serial);
    if (s == null) return false;
    s.write(
      `input swipe ${Math.round(x1)} ${Math.round(y1)} ${Math.round(x2)} ${Math.round(y2)} ${Math.round(durationMs)}`
    );
    return true;
  }

  keyEvent(serial: string, key: string): boolean {
    const keycode = KEYCODE_MAP.get(key.toLowerCase()) ?? key;
    if (!RAW_KEYCODE.test(keycode)) return false;
    const s = this.shell(serial);
    if (s == null) return false;
    s.write(`input keyevent ${keycode}`);
    return true;
  }

  text(serial: string, value: string): boolean {
    const s = this.shell(serial);
    if (s == null) return false;
    // Spaces travel as %s, which `input` restores on the device.
    const typable = typableText(value);
    if (typable === "") return false;
    s.write(`input text ${shellSingleQuote(typable.replace(/ /g, "%s"))}`);
    return true;
  }

  disposeDevice(serial: string): void {
    this.shells.get(serial)?.dispose();
    this.shells.delete(serial);
  }

  dispose(): void {
    for (const s of this.shells.values()) s.dispose();
    this.shells.clear();
  }
}
