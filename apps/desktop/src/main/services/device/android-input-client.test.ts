/**
 * Every line this client writes is executed by the device's shell, and the
 * values that reach it come from the model (device_interact) or from the
 * mirror panel's keyboard. Two properties keep a value a value: one call
 * writes exactly one line, and nothing the caller supplies is ever read by
 * the shell as syntax.
 *
 * The shell is stubbed out, so these run without adb or a device.
 */
import { EventEmitter } from "events";

import { describe, expect, it, vi } from "vitest";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  kill = vi.fn();
}

let shellProcess: FakeProcess;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: () => {
      shellProcess = new FakeProcess();
      Object.assign(shellProcess.stdout, { resume: vi.fn() });
      Object.assign(shellProcess.stderr, { resume: vi.fn() });
      return shellProcess;
    },
  };
});

import { AndroidInputClient, type DeviceShell } from "./android-input-client";

const SERIAL = "emulator-5554";

/** A client whose shell records command lines instead of running them. */
function recordingClient(): { client: AndroidInputClient; lines: string[] } {
  const lines: string[] = [];
  const shell: DeviceShell = {
    write: (line) => lines.push(line),
    dispose: () => {},
  };
  return {
    client: new AndroidInputClient(
      () => "/usr/bin/adb",
      () => shell
    ),
    lines,
  };
}

/**
 * Splits a command line into words the way a POSIX shell does, and returns
 * null when the line contains anything the shell would read as syntax rather
 * than as text — which is exactly what must never come from a caller's value.
 */
function shellWords(line: string): string[] | null {
  const SYNTAX = '";&|<>()$`*?~#!{}\n\r';
  const words: string[] = [];
  let current = "";
  let started = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return null;
      current += line.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }
    if (c === "\\") {
      const next = line[i + 1];
      if (next === undefined || next === "\n" || next === "\r") return null;
      current += next;
      started = true;
      i += 2;
      continue;
    }
    if (c === " ") {
      if (started) words.push(current);
      current = "";
      started = false;
      i++;
      continue;
    }
    if (SYNTAX.includes(c)) return null;
    current += c;
    started = true;
    i++;
  }
  if (started) words.push(current);
  return words;
}

/** Values a caller can supply, including ones full of shell punctuation. */
const TEXT_VALUES = [
  "plain text",
  "line one\nline two",
  "carriage\rreturn",
  "quotes ' and \" together",
  "semi ; colon",
  "amp & and pipe |",
  "dollar $HOME and `backtick`",
  "parens ( ) and braces { }",
  "glob * ? and tilde ~",
  "tab\tseparated",
  "üñïçôdé émoji 🎉",
];

describe("typing text on an Android device", () => {
  it.each(TEXT_VALUES)("writes a single shell word for %j", (value) => {
    const { client, lines } = recordingClient();
    client.text(SERIAL, value);

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/[\r\n]/);
    const words = shellWords(lines[0]);
    expect(words).not.toBeNull();
    // `input`, `text`, and one argument — never a second command.
    expect(words).toHaveLength(3);
    expect(words?.slice(0, 2)).toEqual(["input", "text"]);
  });

  it("delivers the characters the caller asked for", () => {
    const { client, lines } = recordingClient();
    client.text(SERIAL, "hello world");
    // `input text` turns %s back into a space on the device.
    expect(shellWords(lines[0])?.[2]).toBe("hello%sworld");
  });

  it("keeps punctuation as literal characters", () => {
    const { client, lines } = recordingClient();
    client.text(SERIAL, "a;b|c&d$e`f'g\"h");
    expect(shellWords(lines[0])?.[2]).toBe("a;b|c&d$e`f'g\"h");
  });

  it("drops characters a device keyboard cannot type", () => {
    const { client, lines } = recordingClient();
    client.text(SERIAL, "before\nafter");
    expect(shellWords(lines[0])?.[2]).toBe("beforeafter");
  });

  it("writes nothing when there is nothing typable left", () => {
    const { client, lines } = recordingClient();
    expect(client.text(SERIAL, "\n\r\u0000")).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("pressing a key on an Android device", () => {
  it("maps the friendly names", () => {
    const { client, lines } = recordingClient();
    expect(client.keyEvent(SERIAL, "enter")).toBe(true);
    expect(client.keyEvent(SERIAL, "volume_up")).toBe(true);
    expect(lines).toEqual([
      "input keyevent KEYCODE_ENTER",
      "input keyevent KEYCODE_VOLUME_UP",
    ]);
  });

  it("accepts a raw keycode in Android's own shape", () => {
    const { client, lines } = recordingClient();
    expect(client.keyEvent(SERIAL, "KEYCODE_APP_SWITCH")).toBe(true);
    expect(lines).toEqual(["input keyevent KEYCODE_APP_SWITCH"]);
  });

  it.each([
    "",
    "KEYCODE_",
    "KEYCODE_HOME extra",
    "KEYCODE_HOME;true",
    "KEYCODE_HOME|true",
    "KEYCODE_$HOME",
    "KEYCODE_home",
    "keycode_home",
    "constructor",
    "toString",
    `KEYCODE_${"A".repeat(64)}`,
  ])("refuses %j", (key) => {
    const { client, lines } = recordingClient();
    expect(client.keyEvent(SERIAL, key)).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("pointer commands", () => {
  it("writes rounded integers only", () => {
    const { client, lines } = recordingClient();
    client.tap(SERIAL, 10.4, 20.6);
    client.longPress(SERIAL, 1.2, 3.4, 500);
    client.swipe(SERIAL, 1, 2, 3, 4, 250);
    expect(lines).toEqual([
      "input tap 10 21",
      "input swipe 1 3 1 3 500",
      "input swipe 1 2 3 4 250",
    ]);
    for (const line of lines) expect(shellWords(line)).not.toBeNull();
  });
});

describe("the adb shell behind the client", () => {
  it("survives its stdin failing after the device goes away", () => {
    const client = new AndroidInputClient(() => "/usr/bin/adb");
    client.tap(SERIAL, 1, 1);

    // An EPIPE on the pipe arrives as a stream event, not a process one.
    expect(() =>
      shellProcess.stdin.emit("error", new Error("EPIPE"))
    ).not.toThrow();
  });
});
