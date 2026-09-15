/**
 * How a command is handed to a backend, with the spawn itself stubbed out.
 *
 * Two things here are worth holding still. The selection decides whether pi's
 * own local shell runs or is replaced — and returning operations on a platform
 * they cannot work on (or null where confinement was demanded) is the kind of
 * mistake that either breaks every command or quietly removes the sandbox. The
 * argv and environment are the other: a wrong `--volume` gives the container a
 * different project than the file tools are reading, and a dropped PATH means
 * the user's toolchain is missing from every command.
 *
 * Separate from backends.test.ts because that one runs real commands to pin how
 * the spawn is waited on, and `child_process` is mocked wholesale here.
 */
import { EventEmitter } from "node:events";
import * as path from "node:path";

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCurrentMode } from "./current-mode.js";
import { AgentMode } from "./protocol.js";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("child_process", () => ({ spawn }));

/**
 * The sandbox decision, stubbed: what is under test here is the spawn that
 * follows it, and the real decision would start the sandbox runtime.
 */
const decide = vi.hoisted(() => vi.fn());

/** What the runtime says it refused for the last command; empty by default. */
const refusedByRuntime = vi.hoisted(() => ({ list: [] as unknown[] }));
const hostsAllowed = vi.hoisted(() => ({
  once: [] as string[],
  session: [] as string[],
}));

vi.mock("./sandbox/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox/index.js")>()),
  decide,
  violations: () => null,
  denials: () => refusedByRuntime.list,
  allowHostOnce: (host: string) => hostsAllowed.once.push(host),
  allowHostForSession: (host: string) => hostsAllowed.session.push(host),
}));

/** Run the command confined under a plain bash, the shape every backend yields. */
const confined = (): void => {
  decide.mockImplementation(async (_policy: unknown, command: string) => ({
    kind: "confined",
    argv: ["/bin/bash", "-c", command],
    backend: "sandbox-runtime",
  }));
};

/** No backend here: the platform's own shell, unconfined. */
const unconfined = (): void => {
  decide.mockResolvedValue({
    kind: "unconfined",
    reason: "unsupported-platform",
  });
};

const refused = (): void => {
  decide.mockResolvedValue({
    kind: "refused",
    message: "Command refused: the sandbox could not be established.",
  });
};

/**
 * The login shell's environment, stubbed. The real one shells out to source the
 * user's profile, which is both slow and different on every machine.
 */
const SHELL_ENV = { PATH: "/opt/homebrew/bin:/usr/bin", LANG: "en_US.UTF-8" };

vi.mock("./sandbox/shell.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox/shell.js")>()),
  loginEnvironment: () => SHELL_ENV,
}));

/** A child's pipe: an emitter the backend is also allowed to tear down. */
class FakeStream extends EventEmitter {
  destroy = vi.fn();
}

/**
 * A child process that emits nothing until a test tells it to, and even then
 * only once the backend is listening: the sandbox decision is asynchronous, so
 * the spawn happens a tick after `exec` is called, as with a real child.
 */
class FakeChild extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = { end: vi.fn() };
  kill = vi.fn();
  pid = 4242;
  private readonly attached = new Promise<void>((resolve) => {
    this.on("newListener", (name: string) => {
      if (name === "close") resolve();
    });
  });

  /** Finish the command the way a clean exit does. */
  finish(code: number | null): void {
    void this.attached.then(() => this.emit("close", code));
  }

  /** Fail to start, the way ENOENT does. */
  fail(error: Error): void {
    void this.attached.then(() => this.emit("error", error));
  }

  output(text: string): void {
    void this.attached.then(() => this.stdout.emit("data", Buffer.from(text)));
  }

  errorOutput(text: string): void {
    void this.attached.then(() => this.stderr.emit("data", Buffer.from(text)));
  }
}

let child: FakeChild;
const realPlatform = process.platform;

/** Pretend this process is running on `platform` for the current test. */
const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
};

/** Resolves once the backend has spawned the child, a tick after `exec`. */
const spawned = (): Promise<void> =>
  vi.waitFor(() => expect(spawn).toHaveBeenCalled());

/** The argv of the last spawn, as one array. */
const lastSpawn = (): { file: string; args: string[]; options: unknown } => {
  const call = spawn.mock.calls.at(-1) as [string, string[], unknown];

  return { file: call[0], args: call[1], options: call[2] };
};

const load = async (): Promise<typeof import("./backends.js")> =>
  import("./backends.js");

/** Run one command through `operations`, collecting everything it wrote. */
const exec = async (
  operations: BashOperations,
  command: string,
  cwd = "/work/project",
  options: Partial<Parameters<BashOperations["exec"]>[2]> = {}
): Promise<{ exitCode: number | null; output: string }> => {
  let output = "";
  const promise = operations.exec(command, cwd, {
    onData: (data: Buffer) => {
      output += data.toString();
    },
    ...options,
  } as Parameters<BashOperations["exec"]>[2]);

  return { ...(await promise), output };
};

beforeEach(() => {
  vi.clearAllMocks();
  child = new FakeChild();
  spawn.mockImplementation(() => child);
  delete process.env.ABACUSAI_BOT_EXEC_BACKEND;
  delete process.env.ABACUSAI_BOT_SANDBOX;
  delete process.env.ABACUSAI_BOT_DOCKER_IMAGE;
  setCurrentMode(AgentMode.Normal);
});

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
  vi.useRealTimers();
});

describe("reading the backend the desktop selected", () => {
  it.each([
    ["local"],
    ["docker"],
    ["singularity"],
    ["modal"],
    ["daytona"],
    ["ssh"],
  ])("recognises %s", async (backend) => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = backend;
    const { selectedBackend } = await load();

    expect(selectedBackend()).toBe(backend);
  });

  it.each([
    ["nothing set", undefined],
    ["an empty value", ""],
    ["whitespace", "   "],
    ["a backend that does not exist", "podman"],
  ])("falls back to local for %s", async (_label, value) => {
    if (value != null) process.env.ABACUSAI_BOT_EXEC_BACKEND = value;
    const { selectedBackend } = await load();

    expect(selectedBackend()).toBe("local");
  });

  it("accepts a value the desktop wrote with stray case or padding", async () => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "  DoCkEr \n";
    const { selectedBackend } = await load();

    expect(selectedBackend()).toBe("docker");
  });
});

describe("deciding whether to replace pi's own local shell", () => {
  /** backend, sandbox setting, platform, and whether operations are supplied. */
  const cases: [string, string | undefined, NodeJS.Platform, boolean][] = [
    // A container is already an isolation boundary — never double-wrapped.
    ["docker", undefined, "darwin", true],
    ["docker", "strict", "linux", true],
    // Declared but unimplemented: pi's local shell is what actually runs.
    ["singularity", "auto", "darwin", false],
    ["modal", "auto", "darwin", false],
    ["daytona", "auto", "darwin", false],
    ["ssh", "auto", "darwin", false],
    // Local with the sandbox switched off by the environment: pi's path
    // handles shell resolution, login shells and platform differences better
    // than anything here. The mode decides per command, not here.
    ["local", "off", "darwin", false],
    // Local with a backend on this platform.
    ["local", undefined, "darwin", true],
    ["local", "auto", "darwin", true],
    ["local", "auto", "linux", true],
    ["local", "strict", "darwin", true],
    // The Windows rows — no backend, so `auto` steps aside and `strict` keeps
    // the operations for their refusal — are pinned in backends.test.ts.
  ];

  it.each(cases)(
    "%s with sandbox=%s on %s",
    async (backend, sandbox, platform, expectsOperations) => {
      process.env.ABACUSAI_BOT_EXEC_BACKEND = backend;
      if (sandbox != null) process.env.ABACUSAI_BOT_SANDBOX = sandbox;
      onPlatform(platform);
      const { backendOperations } = await load();

      expect(backendOperations() != null).toBe(expectsOperations);
    }
  );

  it("gives pi's bash tool the same answer the operations gave", async () => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "local";
    onPlatform("darwin");
    const { confinedBashTool } = await load();

    expect(confinedBashTool("/work/project")).not.toBeNull();

    process.env.ABACUSAI_BOT_SANDBOX = "off";
    expect(confinedBashTool("/work/project")).toBeNull();
  });
});

describe("running a command in a container", () => {
  beforeEach(() => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "docker";
    // Selecting docker refuses outright on Windows, which has no POSIX host
    // path to mirror. The argv below is the same on every host, so say which
    // one we are on rather than losing the coverage there.
    onPlatform("darwin");
  });

  const dockerOperations = async (): Promise<BashOperations> => {
    const { backendOperations } = await load();
    const operations = backendOperations();
    if (operations == null) throw new Error("expected docker operations");

    return operations;
  };

  it("mounts the workspace at the path the file tools already speak", async () => {
    // The model learns paths from `read` and `grep`, which run on the host. A
    // container that saw the project at /workspace would make every one wrong.
    const operations = await dockerOperations();
    const running = exec(operations, "ls", "/Users/dev/project");
    child.finish(0);
    await running;

    const { file, args } = lastSpawn();

    expect(file).toBe("docker");
    expect(args).toEqual([
      "run",
      "--rm",
      "-i",
      "--name",
      expect.stringContaining("abacusai-bot-"),
      "--workdir",
      "/Users/dev/project",
      "--volume",
      "/Users/dev/project:/Users/dev/project",
      "debian:bookworm-slim",
      "bash",
      "-lc",
      "ls",
    ]);
  });

  it.each([
    ["the configured image", "ghcr.io/acme/dev:2", "ghcr.io/acme/dev:2"],
    ["a padded value", "  node:22  ", "node:22"],
    ["the default when blank", "   ", "debian:bookworm-slim"],
    ["the default when empty", "", "debian:bookworm-slim"],
  ])("uses %s", async (_label, configured, expected) => {
    process.env.ABACUSAI_BOT_DOCKER_IMAGE = configured;
    const operations = await dockerOperations();
    const running = exec(operations, "ls");
    child.finish(0);
    await running;

    expect(lastSpawn().args).toContain(expected);
  });

  it("names every container distinctly, so one can be stopped by name", async () => {
    const operations = await dockerOperations();
    const names: string[] = [];

    for (let i = 0; i < 3; i++) {
      child = new FakeChild();
      spawn.mockImplementation(() => child);
      const running = exec(operations, "ls");
      names.push(lastSpawn().args[4]!);
      child.finish(0);
      await running;
    }

    expect(new Set(names).size).toBe(3);
  });

  it("closes stdin, which -i otherwise holds open until the timeout", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "cat");
    child.finish(0);
    await running;

    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("keeps this process's PATH beside the caller's environment", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls", "/work", {
      env: { FOO: "bar" },
    });
    child.finish(0);
    await running;

    const { env } = lastSpawn().options as { env: Record<string, string> };

    expect(env.FOO).toBe("bar");
    expect(env.PATH).toBe(process.env.PATH);
  });

  it("inherits the environment when the caller supplied none", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls");
    child.finish(0);
    await running;

    expect(lastSpawn().options).toEqual({});
  });

  it("streams both stdout and stderr to the caller", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls");
    child.output("out\n");
    child.errorOutput("err\n");
    child.finish(0);

    expect((await running).output).toBe("out\nerr\n");
  });

  it("tells the model docker is missing rather than tearing the turn down", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls");
    child.fail(new Error("spawn docker ENOENT"));
    const { exitCode, output } = await running;

    // 127: command not found, which is what actually happened.
    expect(exitCode).toBe(127);
    expect(output).toContain("Failed to run command in Docker");
    expect(output).toContain("spawn docker ENOENT");
  });

  it("stops the container by name, not just the client attached to it", async () => {
    // Killing `docker run` only detaches — the command would keep running with
    // nobody reading it.
    const operations = await dockerOperations();
    const controller = new AbortController();
    const running = exec(operations, "sleep 1000", "/work", {
      signal: controller.signal,
    });
    const containerName = lastSpawn().args[4];

    controller.abort();

    expect(spawn).toHaveBeenLastCalledWith(
      "docker",
      ["kill", containerName],
      expect.objectContaining({ stdio: "ignore" })
    );
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.finish(null);
    await running;
  });

  it("reports a real failure code when the client died to a signal", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls");
    child.finish(null);

    expect((await running).exitCode).toBe(1);
  });
});

describe("running a command on this machine", () => {
  beforeEach(() => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "local";
    process.env.ABACUSAI_BOT_SANDBOX = "strict";
    confined();
    refusedByRuntime.list = [];
    hostsAllowed.once = [];
    hostsAllowed.session = [];
  });

  const localOperations = async (): Promise<BashOperations> => {
    const { backendOperations } = await load();
    const operations = backendOperations();
    if (operations == null) throw new Error("expected local operations");

    return operations;
  };

  it("refuses the command instead of running it unconfined", async () => {
    // strict on a platform with no backend: reported as output plus a non-zero
    // exit so the model reads why and adapts.
    onPlatform("win32");
    refused();
    const operations = await localOperations();

    const { exitCode, output } = await exec(operations, "ls");

    // 126: found but not executable — the closest standard code to "refused".
    expect(exitCode).toBe(126);
    expect(output).toContain("Command refused");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("hands the command to bash when the mode asked for no confinement", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "echo hi", "/work/project");
    child.finish(0);
    await running;

    const { file, args, options } = lastSpawn();

    expect(file).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
    expect(options).toMatchObject({ cwd: "/work/project" });
  });

  it("runs the command in its own process group, so a deadline can take down what it started", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "ls");
    child.finish(0);
    await running;

    expect(lastSpawn().options).toMatchObject({ detached: true });
  });

  it("hands over the login shell's environment rather than this process's", async () => {
    // Inheriting would mean the launchd PATH, which cannot find the user's
    // toolchain — the profile is sourced once, not per command.
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "ls");
    child.finish(0);
    await running;

    expect((lastSpawn().options as { env: unknown }).env).toEqual({
      ...SHELL_ENV,
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("keeps the caller's PATH in front of the shell's, and reaches both", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "ls", "/work", {
      env: { PATH: "/caller/bin", TOKEN: "abc" },
    });
    child.finish(0);
    await running;

    const { env } = lastSpawn().options as { env: Record<string, string> };

    expect(env.TOKEN).toBe("abc");
    // The merge joins on this host's PATH delimiter, not the mocked platform's.
    expect(env.PATH).toBe(`/caller/bin${path.delimiter}${SHELL_ENV.PATH}`);
  });

  it("gives the caller's environment the shell's PATH when it brought none", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "ls", "/work", { env: { TOKEN: "abc" } });
    child.finish(0);
    await running;

    const { env } = lastSpawn().options as { env: Record<string, string> };

    expect(env).toEqual({
      TOKEN: "abc",
      PATH: SHELL_ENV.PATH,
      NODE_USE_ENV_PROXY: "1",
    });
  });

  it("merges into the caller's own spelling of PATH", async () => {
    // Windows spells it `Path`, and pi's getShellEnv() passes that casing
    // through. Reading `PATH` found nothing and writing `PATH` left two
    // spellings side by side — libuv keeps one, and it may be the one without
    // pi's bin directory.
    onPlatform("win32");
    unconfined();
    const operations = await localOperations();

    const running = exec(operations, "dir", "C:\\work", {
      env: { Path: "C:\\pi\\bin", TOKEN: "abc" },
    });
    child.finish(0);
    await running;

    const { env } = lastSpawn().options as { env: Record<string, string> };

    // One PATH, under the key that was already there — not a second one
    // beside it.
    expect(env.PATH).toBeUndefined();
    expect(env.Path?.startsWith("C:\\pi\\bin")).toBe(true);
    expect(env.Path).toContain(SHELL_ENV.PATH);
  });

  it("hands the fallback command line over without re-quoting it", async () => {
    // Node's default Windows quoting is the C runtime's, and cmd.exe does not
    // undo it — `git commit -m "msg"` reached cmd with the backslashes in.
    onPlatform("win32");
    unconfined();
    const operations = await localOperations();

    const running = exec(operations, 'git commit -m "msg"', "C:\\work");
    child.finish(0);
    await running;

    expect(lastSpawn().options).toMatchObject({
      windowsVerbatimArguments: true,
    });
    expect(lastSpawn().args.at(-1)).toBe('git commit -m "msg"');
  });

  it("closes stdin so a command that reads it does not hang", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "cat");
    child.finish(0);
    await running;

    expect(child.stdin.end).toHaveBeenCalled();
  });

  it("surfaces a spawn failure as command output", async () => {
    onPlatform("darwin");
    const operations = await localOperations();

    const running = exec(operations, "ls");
    child.fail(new Error("EACCES"));
    const { exitCode, output } = await running;

    expect(exitCode).toBe(127);
    expect(output).toContain("Failed to run command: EACCES");
  });

  it("kills the whole process group on abort", async () => {
    // Killing the shell alone leaves a backgrounded descendant running — and it
    // is that descendant which keeps the turn's output pipes open.
    onPlatform("darwin");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const operations = await localOperations();
    const controller = new AbortController();

    const running = exec(operations, "sleep 1000", "/work", {
      signal: controller.signal,
    });
    await spawned();
    controller.abort();

    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");

    child.finish(null);
    await running;
    kill.mockRestore();
  });

  it("still kills a command whose abort landed while the sandbox was deciding", async () => {
    // The decision is asynchronous; an abort in that gap used to be missed.
    onPlatform("darwin");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const operations = await localOperations();
    const controller = new AbortController();

    const running = exec(operations, "sleep 1000", "/work", {
      signal: controller.signal,
    });
    controller.abort();
    await spawned();

    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");

    child.finish(null);
    await running;
    kill.mockRestore();
  });

  it("falls back to killing the child when its group is already gone", async () => {
    onPlatform("darwin");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });
    const operations = await localOperations();
    const controller = new AbortController();

    const running = exec(operations, "sleep 1000", "/work", {
      signal: controller.signal,
    });
    await spawned();
    controller.abort();

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");

    child.finish(null);
    await running;
    kill.mockRestore();
  });
});

describe("settling when the command finishes rather than when its pipes close", () => {
  beforeEach(() => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "docker";
    // Docker is refused on Windows; the settling logic under test is not
    // platform-specific.
    onPlatform("darwin");
  });

  const dockerOperations = async (): Promise<BashOperations> => {
    const { backendOperations } = await load();
    const operations = backendOperations();
    if (operations == null) throw new Error("expected docker operations");

    return operations;
  };

  it("returns when a descendant still holds the pipes open", async () => {
    // `nohup node server.js &` runs in a subshell that outlives the shell and
    // keeps its stdout — waiting for `close` there wedges the tool call until
    // the app's inactivity timeout.
    vi.useFakeTimers();
    const operations = await dockerOperations();
    const running = exec(operations, "nohup node server.js &");

    child.emit("exit", 0);
    await vi.advanceTimersByTimeAsync(200);

    expect((await running).exitCode).toBe(0);
  });

  it("does not truncate a descendant that is still writing", async () => {
    vi.useFakeTimers();
    const operations = await dockerOperations();
    const running = exec(operations, "slow");

    child.emit("exit", 0);
    // Output keeps arriving, re-arming the grace period each time.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50);
      child.output(`chunk${i}`);
    }
    await vi.advanceTimersByTimeAsync(200);

    expect((await running).output).toBe("chunk0chunk1chunk2chunk3chunk4");
  });

  it("finishes immediately when both pipes drained before the exit", async () => {
    const operations = await dockerOperations();
    const running = exec(operations, "ls");

    child.stdout.emit("end");
    child.stderr.emit("end");
    child.emit("exit", 3);

    expect((await running).exitCode).toBe(3);
  });
});

describe("running a project command through the backend", () => {
  // Docker is refused on Windows, and none of what these pin is host-specific.
  beforeEach(() => {
    onPlatform("darwin");
  });

  it("declines when there is no backend, so the caller uses pi's own exec", async () => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "local";
    process.env.ABACUSAI_BOT_SANDBOX = "off";
    onPlatform("darwin");
    const { execConfined } = await load();

    await expect(execConfined("npm test", "/work")).resolves.toBeNull();
  });

  it("returns everything the command wrote as stdout", async () => {
    // The backends stream both streams through one callback and cannot separate
    // them, and every caller concatenates the two anyway.
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "docker";
    const { execConfined } = await load();

    const running = execConfined("npm test", "/work");
    child.output("passing\n");
    child.errorOutput("warning\n");
    child.finish(0);

    expect(await running).toEqual({
      stdout: "passing\nwarning\n",
      stderr: "",
      code: 0,
      killed: false,
    });
  });

  it("reports a failing command's exit code", async () => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "docker";
    const { execConfined } = await load();

    const running = execConfined("npm test", "/work");
    child.finish(2);

    expect((await running)?.code).toBe(2);
  });

  it("passes a timeout and a signal down to the backend", async () => {
    vi.useFakeTimers();
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "docker";
    const { execConfined } = await load();
    const controller = new AbortController();

    const running = execConfined("npm test", "/work", {
      timeout: 5,
      signal: controller.signal,
    });
    // The deadline is in seconds; at five of them the container is stopped.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(spawn).toHaveBeenLastCalledWith(
      "docker",
      ["kill", expect.stringContaining("abacusai-bot-")],
      expect.objectContaining({ stdio: "ignore" })
    );

    child.finish(null);
    await running;
  });
});

describe("asking about what the sandbox refused", () => {
  beforeEach(() => {
    process.env.ABACUSAI_BOT_EXEC_BACKEND = "local";
    process.env.ABACUSAI_BOT_SANDBOX = "strict";
    onPlatform("darwin");
    confined();
    refusedByRuntime.list = [
      { kind: "write", path: "/Users/dev/Desktop/out.txt" },
      { kind: "host", host: "api.test", port: 443 },
    ];
    hostsAllowed.once = [];
    hostsAllowed.session = [];
  });

  /** Two children in turn: the refused run, then the retry. */
  const twoRuns = (): FakeChild[] => {
    const first = child;
    const second = new FakeChild();
    let calls = 0;
    spawn.mockImplementation(() => (++calls === 1 ? first : second));

    return [first, second];
  };

  it("asks once, then runs the command again with what was allowed", async () => {
    const { backendOperations } = await load();
    const { SandboxApprovals } = await import("./sandbox/approvals.js");
    const approvals = new SandboxApprovals();
    const asked: unknown[] = [];
    approvals.askDenials = async (command, refused) => {
      asked.push({ command, refused });

      return { once: refused, session: [] };
    };
    const operations = backendOperations(approvals);
    if (operations == null) throw new Error("expected local operations");
    const [first, second] = twoRuns();

    const running = exec(operations, "cp x ~/Desktop/out.txt");
    first!.finish(1);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    second!.finish(0);
    const { exitCode, output } = await running;

    expect(exitCode).toBe(0);
    expect(asked).toHaveLength(1);
    expect(output).toContain("running the command again");
    // The write was handed to the retry's policy (beside whatever the
    // command's own text was granted, sandbox/intent.ts), the host to the proxy.
    expect(
      (decide.mock.calls[1]![0] as { approvedWrites: string[] }).approvedWrites
    ).toContain("/Users/dev/Desktop/out.txt");
    expect(hostsAllowed.once).toEqual(["api.test"]);
    expect(hostsAllowed.session).toEqual([]);
  });

  it("asks even when the command's last step exited 0", async () => {
    // `rm x; echo done` succeeds as far as bash is concerned; the refusal is
    // still real and still the user's to lift.
    const { backendOperations } = await load();
    const { SandboxApprovals } = await import("./sandbox/approvals.js");
    const approvals = new SandboxApprovals();
    let asked = 0;
    approvals.askDenials = async (_command, refused) => {
      asked += 1;

      return { once: refused, session: [] };
    };
    const operations = backendOperations(approvals);
    if (operations == null) throw new Error("expected local operations");
    const [first, second] = twoRuns();

    const running = exec(operations, "rm ~/Desktop/x; echo done");
    first!.finish(0);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    second!.finish(0);
    await running;

    expect(asked).toBe(1);
  });

  it("keeps the refusal when the user says no", async () => {
    const { backendOperations } = await load();
    const { SandboxApprovals } = await import("./sandbox/approvals.js");
    const approvals = new SandboxApprovals();
    approvals.askDenials = async () => null;
    const operations = backendOperations(approvals);
    if (operations == null) throw new Error("expected local operations");

    const running = exec(operations, "cp x ~/Desktop/out.txt");
    child.finish(1);
    const { exitCode } = await running;

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("does not ask when nobody can answer, and never retries twice", async () => {
    const { backendOperations } = await load();
    const operations = backendOperations();
    if (operations == null) throw new Error("expected local operations");

    const running = exec(operations, "cp x ~/Desktop/out.txt");
    child.finish(1);
    const { exitCode } = await running;

    expect(exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
