import { spawnSync } from "node:child_process";
/**
 * The unit of `BashOperations.exec`'s timeout, pinned.
 *
 * This is a boundary where the type says `number` and the unit is carried only
 * by convention: pi hands a replacement backend the model's `timeout` argument
 * in SECONDS, because pi's own implementation of the interface is what converts
 * it. Reading it as milliseconds is silent — nothing fails to compile, nothing
 * throws — and it turns every command into one that is killed before it can
 * produce a byte, which reaches the model as `(no output)` and exit 1 with no
 * hint that a deadline was involved.
 *
 * That shipped. These tests are the thing that would have caught it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  backendOperations,
  deadline,
  hiddenStoreNote,
  refusedHostNote,
  selectedBackend,
} from "./backends.js";
import { currentMode, setCurrentMode } from "./current-mode.js";
import { budgetSecondsFor } from "./extensions/tool-timeouts.js";
import { AgentMode } from "./protocol.js";

describe("deadline", () => {
  it("reads its argument as seconds, not milliseconds", () => {
    vi.useFakeTimers();

    try {
      const expired = vi.fn();

      deadline(2, expired);

      // The millisecond reading fires here, 1000x early.
      vi.advanceTimersByTime(1_000);
      expect(expired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1_001);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("agrees with the budget the tool-timeouts extension stamps", () => {
    // The two modules never reference each other, so nothing but a test keeps
    // them speaking the same unit. The extension stamps `bash` with a budget in
    // seconds; a command must survive to the edge of it.
    vi.useFakeTimers();

    try {
      const budget = budgetSecondsFor("bash");
      const expired = vi.fn();

      deadline(budget, expired);

      vi.advanceTimersByTime(budget * 1_000 - 1);
      expect(expired).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no deadline when the model set none", () => {
    // pi documents bash as having no default timeout, so `undefined` has to mean
    // "run until it finishes", not "expire immediately".
    expect(deadline(undefined, vi.fn())).toBeNull();
  });

  it("has no deadline for a value that cannot be one", () => {
    // Straight from the model's arguments, so it is not necessarily a number
    // that makes sense. A zero or negative delay would otherwise be a timer that
    // fires on the next tick and kills the command instantly.
    for (const bogus of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deadline(bogus, vi.fn())).toBeNull();
    }
  });
});

/**
 * The turn ends when the command ends — not when the last thing it started
 * closes its inherited pipes.
 *
 * A real session wedged here. The model restarted a dev server with
 * `cd app && nohup node server.js >> log 2>&1 &`; bash runs a backgrounded
 * compound list in a subshell, that subshell outlives the shell, and it holds
 * the tool's stdout and stderr (the redirect binds to `node`, not to the
 * subshell). The shell exited in three seconds; the tool call never returned,
 * and the session sat silent until the app's ten-minute inactivity timeout.
 */
describe("a command that leaves something running behind it", () => {
  const ops = backendOperations();
  // Only the local backend spawns processes here; docker needs a daemon and
  // `off` hands the work back to pi, whose own path already does this.
  const withLocalBackend =
    ops != null && selectedBackend() === "local" ? it : it.skip;

  let scratch: string;
  let restoreMode: AgentMode;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "backends-test-"));
    // What is under test is how the spawn is waited on, which is the same
    // whether or not the command ends up confined. Running unconfined is what
    // makes that reachable everywhere: the Linux runner has a bubblewrap that
    // cannot be established, and its (correct) answer to any other mode is to
    // refuse the command outright — which would leave this covered on macOS
    // only, and the hang it pins is not platform-specific.
    restoreMode = currentMode();
    setCurrentMode(AgentMode.Yolo);
  });

  afterEach(() => {
    setCurrentMode(restoreMode);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Alive? The token is the sleep's own duration, unique per test. */
  const survivors = (token: string): string =>
    spawnSync("pgrep", ["-f", `sleep ${token}`], {
      encoding: "utf8",
    }).stdout.trim();

  /**
   * Backgrounds a process that outlives the shell, exactly as the bug did: the
   * `&&` makes it a compound list, so bash runs it in a subshell that stays
   * alive for the sleep's duration — and the redirect binds to the `sleep`
   * inside it, leaving that subshell holding this command's stdout and stderr.
   */
  const lingering = (token: string): string =>
    `cd ${scratch} && nohup sleep ${token} >> out.log 2>&1 & \nsleep 0.2; echo READY`;

  withLocalBackend(
    "returns when the shell exits, not when the descendant does",
    async () => {
      const token = "20.7311";
      const started = Date.now();
      let output = "";

      const result = await ops!.exec(lingering(token), scratch, {
        onData: (chunk: Buffer) => {
          output += String(chunk);
        },
        timeout: 30,
      });
      const elapsed = (Date.now() - started) / 1000;

      expect(result.exitCode).toBe(0);
      expect(output).toContain("READY");
      // The descendant holds the pipes for 20s; anything near that is the hang.
      expect(elapsed).toBeLessThan(5);
      // And it must still be running, or this passed for the wrong reason — a
      // background process that died on its own holds nothing, and the wait
      // under test would never have been exercised.
      expect(survivors(token)).not.toBe("");

      spawnSync("pkill", ["-f", `sleep ${token}`]);
    }
  );

  withLocalBackend(
    "takes down what it started when the deadline expires",
    async () => {
      const token = "20.8422";

      const result = await ops!.exec(`${lingering(token)}\nsleep 30`, scratch, {
        onData: () => {},
        timeout: 1,
      });

      expect(result.exitCode).not.toBe(0);
      // Killing only the shell would orphan the group rather than end it — which
      // is what left the original hang's deadline with nothing to reach.
      expect(survivors(token)).toBe("");
    }
  );
});

describe("a platform with no sandbox backend (Windows)", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    vi.unstubAllEnvs();
  });

  it("hands `auto` back to pi's local path instead of spawning /bin/bash", () => {
    // The local operations' unconfined fallback is a /bin/bash argv, which
    // does not exist on Windows — every command would fail ENOENT. Null means
    // pi's own platform-correct local path runs instead.
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
    vi.stubEnv("ABACUSAI_BOT_SANDBOX", "auto");

    expect(backendOperations()).toBeNull();
  });

  it("keeps the operations under `strict`, so the refusal reaches the model", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "local");
    vi.stubEnv("ABACUSAI_BOT_SANDBOX", "strict");

    expect(backendOperations()).not.toBeNull();
  });

  it("refuses the docker backend outright, at construction", () => {
    // The container mounts the workspace at its host path so the model's
    // paths keep working inside — and `C:\...` is never a valid mount
    // destination or workdir in a Linux guest. One clear failure at selection
    // beats a mount error on every command.
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "docker");

    expect(() => backendOperations()).toThrow(/POSIX host path/);
  });

  it("still constructs the docker backend elsewhere", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.stubEnv("ABACUSAI_BOT_EXEC_BACKEND", "docker");

    expect(backendOperations()).not.toBeNull();
  });
});

describe("the note on a failed command that hit a hidden store", () => {
  it("names the store and points at the prompt, not a workaround", () => {
    const note = hiddenStoreNote(
      "cat: /home/dev/.netrc: Operation not permitted\n",
      ["/home/dev/.ssh", "/home/dev/.netrc"]
    );
    expect(note).toContain("/home/dev/.netrc");
    expect(note).toContain("approve");
    expect(note).not.toContain("/home/dev/.ssh");
  });

  it("is silent when the output mentions no store", () => {
    expect(hiddenStoreNote("npm ERR! 404", ["/home/dev/.netrc"])).toBeNull();
  });
});

describe("the note on a command the proxy refused", () => {
  it("names the host and sends the model to the user", () => {
    const note = refusedHostNote(
      "curl: (22) evil.test is not allowed by the sandbox"
    );
    expect(note).toContain("evil.test");
    expect(note).toContain("tell the user");
  });

  it("is silent otherwise", () => {
    expect(refusedHostNote("curl: (7) Failed to connect")).toBeNull();
  });
});
