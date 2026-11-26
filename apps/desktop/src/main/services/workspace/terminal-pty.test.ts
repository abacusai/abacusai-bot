// A real shell through the terminal service, on each system CI runs: start,
// type, read, resize, close, and a deleted chat's shell ending.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  conversationKey,
  sessionConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalSessionService } from "./terminal-session-service";

/** Every real PTY the service spawned, and when each one exited. */
const spawned: Promise<void>[] = [];
vi.mock("@lydell/node-pty", async (original) => {
  const real = await original<typeof import("@lydell/node-pty")>();
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const pty = real.spawn(...args);
      spawned.push(new Promise((resolve) => pty.onExit(() => resolve())));
      return pty;
    },
  };
});

const windows = process.platform === "win32";
// The command prompt starts in a blink and prints no profile; elsewhere the
// user's own login shell.
const SHELL = windows ? "cmd" : "system";
const ENTER = "\r";

let workspace: string;
let output: Map<string, string>;
let retired: string[];
let terminals: TerminalSessionService;

beforeEach(() => {
  workspace = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "terminal-pty-"))
  );
  output = new Map();
  retired = [];
  terminals = new TerminalSessionService({
    resolveWorkspacePath: () => workspace,
    emitTerminalOutput: ({ terminalId, data }) =>
      output.set(terminalId, (output.get(terminalId) ?? "") + data),
    emitTerminalExit: () => {},
    emitTerminalState: () => {},
    emitTerminalRetired: ({ terminalId, reason }) =>
      retired.push(`${terminalId}:${reason}`),
  });
});

afterEach(async () => {
  terminals.dispose();
  // Windows holds a folder a live process sits in (EBUSY): the shells end
  // first, then it goes.
  await until("every shell to exit after dispose", () => false, {
    settled: Promise.all(spawned.splice(0)),
  });
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * Each wait has its own deadline, short enough that a test's waits fit the
 * serial project's 60 s, and says what it waited for and what the shell
 * printed, so a failure on another system reads without a rerun.
 */
const WAIT_MS = 10_000;
const until = async (
  what: string,
  check: () => boolean,
  { settled }: { settled?: Promise<unknown> } = {}
): Promise<void> => {
  let done = false;
  void settled?.then(() => (done = true));
  const deadline = Date.now() + WAIT_MS;
  while (!(settled ? done : check())) {
    if (Date.now() > deadline)
      throw new Error(
        `Timed out after ${WAIT_MS / 1000} s waiting for ${what}. Output so far: ${JSON.stringify(
          [...output.keys()].map((id) => [id, plain(id).slice(-400)])
        )}`
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** Output with its escape sequences and line breaks taken out. */
const plain = (terminalId: string): string =>
  (output.get(terminalId) ?? "")
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\r\n]+/g, " ");

const start = async (sessionId: string, terminalId: string) => {
  const conversation = sessionConversationRef("workspace-1", sessionId);
  const started = await terminals.startSession({
    terminalId,
    conversation,
    conversationKey: conversationKey(conversation),
    generation: null,
    cols: 80,
    rows: 24,
    shell: SHELL,
  });
  expect(started).toMatchObject({ success: true, created: true });
  const runtime = {
    terminalId,
    conversationKey: conversationKey(conversation),
    generation: started.state.generation,
  };
  const type = (line: string) =>
    expect(terminals.writeInput({ ...runtime, data: line + ENTER })).toBe(true);
  return { runtime, type };
};

describe("a real terminal", () => {
  it("starts a shell in the chat's folder, runs what is typed, resizes and closes", async () => {
    const { runtime, type } = await start("chat-1", "smoke");

    // What only a shell running the line prints: the folder it started in.
    const folder = path.basename(workspace);
    type(
      windows ? "echo pty-smoke-%CD%" : 'echo pty-smoke-$((6*7))-"${PWD##*/}"'
    );
    // The command prompt's own prompt names the folder too: the echo's
    // output is the drive path after the marker, which only running it prints.
    const echoed = windows
      ? new RegExp(`pty-smoke-[A-Za-z]:\\\\\\S*${folder}`)
      : new RegExp(`pty-smoke-42-${folder}`);
    await until("the echo", () => echoed.test(plain("smoke")));
    expect(
      terminals.outputState({ ...runtime, fromOffset: 0 })?.data
    ).toContain("pty-smoke-");

    expect(
      terminals.resizeSession({ ...runtime, cols: 100, rows: 30 })
    ).toBeTypeOf("number");
    if (windows) {
      type("mode con");
      await until("the new width", () => /Columns:\s+100/.test(plain("smoke")));
    } else {
      type("stty size");
      await until("the new size", () => plain("smoke").includes("30 100"));
    }

    expect(terminals.hideSession({ ...runtime, close: true })).toBe(true);
    expect(retired).toEqual(["smoke:closed"]);
    expect(terminals.hasLiveSessions()).toBe(false);
    expect(terminals.writeInput({ ...runtime, data: "echo late" })).toBe(false);
  });

  it.skipIf(windows)(
    "holds the update restart for a running program only, and a deleted chat's shell ends",
    async () => {
      const { runtime, type } = await start("chat-2", "busy");
      type("echo shell-pid-$$");
      await until("the shell's pid", () => /shell-pid-\d+/.test(plain("busy")));
      const pid = Number(/shell-pid-(\d+)/.exec(plain("busy"))![1]);
      expect(terminals.holdsRendererSwap()).toBe(false);

      type("sleep 30");
      await until("sleep in the foreground", () =>
        terminals.holdsRendererSwap()
      );
      expect(terminals.busyProgram(runtime.conversationKey, "busy")).toBe(
        "sleep"
      );

      terminals.disposeConversation("workspace-1", "chat-2");
      expect(retired).toEqual(["busy:closed"]);
      await until("the shell to end", () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(terminals.holdsRendererSwap()).toBe(false);
    }
  );
});
