/**
 * The sandbox, at two levels.
 *
 * The pure parts — mode mapping, profile construction, the decision table —
 * are tested everywhere. The confinement itself is tested against the real
 * kernel, and only on a platform with a backend: asserting that a Seatbelt
 * profile denies a write is meaningless anywhere but macOS, and a test that
 * quietly passes on the wrong platform is worse than one that skips.
 *
 * The live section includes the escape a security review found in the first
 * version of this code — an app bundle written into the writable workspace and
 * started through LaunchServices, which runs outside the sandbox entirely.
 * That is here as a regression test, not as an illustration: a sandbox with no
 * test that tries to break out is a sandbox that quietly stops working.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AgentMode } from "../protocol.js";
import {
  buildArgs,
  busNeutralizingArgs,
  execFailureStatus,
  runProbe,
  tmpPathBinds,
  xdgRuntimeDir,
} from "./bubblewrap.js";
import { backendName, decide, unavailableBackendMessage } from "./index.js";
import {
  canonicalize,
  modeToSandboxMode,
  resolvePolicy,
  sandboxEnforcement,
  type SandboxPolicy,
} from "./policy.js";
import { buildProfile, policyRefusal } from "./seatbelt.js";
import { resolveSecretPaths } from "./secrets.js";

const onMac = process.platform === "darwin";
const onLinux = process.platform === "linux";
const onWindows = process.platform === "win32";

function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    mode: "workspace-write",
    enforcement: "auto",
    workspaceRoot: "/tmp/ws",
    writableTemp: ["/private/tmp"],
    secrets: { denied: [], allowed: [], promptable: [] },
    ...overrides,
  };
}

describe("mode mapping", () => {
  it("follows the permission mode rather than adding a second control", () => {
    expect(modeToSandboxMode(AgentMode.PlanMode)).toBe("read-only");
    expect(modeToSandboxMode(AgentMode.Normal)).toBe("workspace-write");
    expect(modeToSandboxMode(AgentMode.AcceptEdits)).toBe("workspace-write");
    // Bypass means the user turned the asking off deliberately. Enforcing a
    // sandbox against that would be overriding them.
    expect(modeToSandboxMode(AgentMode.Yolo)).toBe("danger-full-access");
  });

  it("canonicalizes the workspace, because the kernel matches resolved paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbx-canon-"));
    try {
      const resolved = canonicalize(dir);
      expect(path.isAbsolute(resolved)).toBe(true);
      // On macOS /tmp IS /private/tmp; a profile naming the symlink grants
      // nothing.
      if (onMac) expect(resolved.startsWith("/private/")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still produces a policy for a path that does not exist yet", () => {
    // `mkdir && cd` patterns would break if an unresolvable path threw.
    const resolved = resolvePolicy(
      AgentMode.Normal,
      "/tmp/does-not-exist-yet-12345"
    );
    expect(resolved.workspaceRoot).toContain("does-not-exist-yet-12345");
  });
});

describe("the decision table", () => {
  it("does not confine when the user asked for no confinement", () => {
    expect(decide(policy({ enforcement: "off" }), "ls", "/tmp/ws").kind).toBe(
      "unconfined"
    );
    expect(
      decide(policy({ mode: "danger-full-access" }), "ls", "/tmp/ws").kind
    ).toBe("unconfined");
  });

  it("confines on a platform that has a working backend", () => {
    if (backendName() === null) return;
    const decision = decide(policy(), "echo hi", "/tmp/ws");
    // backendName() answers "does this PLATFORM have a backend" from
    // process.platform alone; decide() additionally requires that the backend
    // can actually be established. Those differ on exactly the machines this
    // suite runs on — a container or CI runner with no bwrap binary, or with
    // unprivileged user namespaces disabled, is Linux with an unusable
    // bubblewrap. Its contract is refusal, asserted next; only the
    // establishable case belongs in this test.
    if (decision.kind === "refused") return;
    expect(decision.kind).toBe("confined");
  });

  it("never runs unconfined when the platform has a backend, working or not", () => {
    if (backendName() === null) return;
    // The security-critical half: an unusable backend must refuse, never
    // silently fall through to an unconfined command. This is the case the
    // Linux runner actually exercises.
    expect(decide(policy(), "echo hi", "/tmp/ws").kind).not.toBe("unconfined");
  });

  it("refuses, rather than throwing, when the policy cannot be expressed", () => {
    if (backendName() !== "seatbelt") return;
    const decision = decide(
      policy({ workspaceRoot: "/tmp/bad\nname" }),
      "echo hi",
      "/tmp/ws"
    );
    expect(decision.kind).toBe("refused");
  });

  it("refuses rather than running unconfined when strict has no backend", () => {
    if (backendName() !== null) return;
    const decision = decide(
      policy({ enforcement: "strict" }),
      "echo hi",
      "/tmp/ws"
    );
    expect(decision.kind).toBe("refused");
  });

  it("does not tell the model to give up, since a later attempt may work", () => {
    // A probe that ran out of time is deliberately left uncached so the next
    // command tries again; a refusal saying "do not retry" contradicts that.
    for (const backend of ["seatbelt", "bubblewrap", "mxc"] as const) {
      const message = unavailableBackendMessage(backend);

      expect(message).not.toContain("do not retry");
      expect(message).toContain("retry is reasonable");
      expect(message).toContain("must not be worked around");
    }
  });

  it("runs unconfined under auto where no backend exists", () => {
    if (backendName() !== null) return;
    const decision = decide(policy(), "echo hi", "/tmp/ws");
    expect(decision.kind).toBe("unconfined");
  });
});

describe("the Seatbelt profile", () => {
  it("denies writes by default and allows the workspace back", () => {
    const profile = buildProfile(policy({ workspaceRoot: "/private/tmp/ws" }));
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('"/private/tmp/ws"');
  });

  it("keeps the workspace unwritable in read-only mode", () => {
    const profile = buildProfile(
      policy({ mode: "read-only", workspaceRoot: "/private/tmp/ws" })
    );
    expect(profile).toContain("(deny file-write*)");
    expect(profile).not.toContain(
      '(allow file-write* (subpath "/private/tmp/ws"))'
    );
  });

  it("still opens the writable temp subpaths in read-only mode", () => {
    // Plan mode needs somewhere to put scratch files or python, compilers,
    // mktemp and git's temp index all fail with "Operation not permitted".
    // This matches the bubblewrap backend, which gives read-only a private
    // /tmp. The workspace stays denied (asserted above); only temp opens up.
    const profile = buildProfile(
      policy({
        mode: "read-only",
        workspaceRoot: "/private/tmp/ws",
        writableTemp: ["/private/tmp", "/private/var/folders/xy"],
      })
    );
    expect(profile).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(profile).toContain(
      '(allow file-write* (subpath "/private/var/folders/xy"))'
    );
    // And crucially not the workspace root.
    expect(profile).not.toContain(
      '(allow file-write* (subpath "/private/tmp/ws"))'
    );
  });

  it("closes the launchd channel, which is how the first version was escaped", () => {
    const profile = buildProfile(policy());
    // By prefix, not by name. An enumerated list went stale once already: the
    // service `open` uses moved, and nothing but the process-exec rule — which
    // a copied binary walks past — was left holding the door.
    expect(profile).toContain("(deny mach-lookup");
    expect(profile).toContain('(global-name-prefix "com.apple.coreservices.")');
    expect(profile).toContain('(global-name-prefix "com.apple.CoreServices.")');
    expect(profile).toContain('(global-name-prefix "com.apple.lsd.")');
  });

  it("escapes quotes and backslashes in a workspace path", () => {
    // The profile is a program. An unescaped quote in a directory name would
    // end the string early and change what the rest of the policy means.
    const profile = buildProfile(
      policy({ workspaceRoot: '/tmp/we"ird\\path' })
    );
    expect(profile).toContain('\\"');
    expect(profile).toContain("\\\\");
  });

  it("refuses a path with control characters, and says why", () => {
    // A newline is legal in an APFS filename but not in the profile, where it
    // fails compilation with an error that explains nothing. The refusal has
    // to happen here, where it can name the actual problem.
    expect(() =>
      buildProfile(policy({ workspaceRoot: "/tmp/bad\nname" }))
    ).toThrow(/control characters/);
    expect(() =>
      buildProfile(policy({ writableTemp: ["/tmp/als\to"] }))
    ).toThrow(/control characters/);
  });

  it("reports such a path as a refusal rather than throwing out of the call", () => {
    // buildProfile throws, but bash's exec path has no catch: a thrown error
    // there tears the turn down and the readable message never reaches the
    // model. The check is asked before the profile is built instead.
    expect(policyRefusal(policy({ workspaceRoot: "/tmp/bad\nname" }))).toMatch(
      /control characters/
    );
    expect(policyRefusal(policy({ writableTemp: ["/tmp/als\to"] }))).toMatch(
      /control characters/
    );
    expect(policyRefusal(policy())).toBeNull();
  });

  it("says nothing about paths the profile never writes down", () => {
    // read-only never interpolates the workspace root, so a name it cannot
    // express is not a reason to refuse the command.
    expect(
      policyRefusal(
        policy({ mode: "read-only", workspaceRoot: "/tmp/bad\nname" })
      )
    ).toBeNull();
  });
});

describe("the bubblewrap arguments", () => {
  it("binds the filesystem read-only and the workspace writable", () => {
    const args = buildArgs(
      policy({ workspaceRoot: "/tmp/ws" }),
      "echo hi",
      "/tmp/ws"
    );
    expect(args.join(" ")).toContain("--ro-bind / /");
    expect(args.join(" ")).toContain("--bind /tmp/ws /tmp/ws");
  });

  it("unshares the PID namespace alongside --proc", () => {
    // Without this, the mounted procfs shows host processes and
    // /proc/<pid>/root resolves in THAT process's mount namespace — a write
    // through it goes around the read-only bind entirely, in read-only mode
    // as much as workspace-write.
    const args = buildArgs(policy(), "echo hi", "/tmp/ws");
    const procIndex = args.indexOf("--proc");
    expect(procIndex).toBeGreaterThan(-1);
    expect(args).toContain("--unshare-pid");
  });

  it("gives read-only mode a private tmpfs rather than the real /tmp", () => {
    const args = buildArgs(policy({ mode: "read-only" }), "echo hi", "/tmp/ws");
    expect(args.join(" ")).toContain("--tmpfs /tmp");
    expect(args.join(" ")).not.toContain("--bind /tmp/ws");
  });

  // Skipped on Windows: a PATH of POSIX /tmp entries splits on ":" there.
  it.skipIf(onWindows)(
    "re-binds a PATH entry under /tmp over the read-only tmpfs",
    () => {
      // An AppImage mounts itself under /tmp/.mount_*, and that is where the
      // vendored rg/fd on the sandbox PATH live; the tmpfs must not hide them.
      const dir = fs.mkdtempSync("/tmp/sbx-vendor-");
      const previous = process.env.PATH;
      try {
        process.env.PATH = `/usr/bin:${dir}`;
        const args = buildArgs(
          policy({ mode: "read-only" }),
          "echo hi",
          "/tmp/ws"
        ).join(" ");
        const tmpfsAt = args.indexOf("--tmpfs /tmp");
        const bindAt = args.indexOf(`--ro-bind ${dir} ${dir}`);
        expect(tmpfsAt).toBeGreaterThan(-1);
        expect(bindAt).toBeGreaterThan(tmpfsAt);
      } finally {
        process.env.PATH = previous;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  // Skipped on Windows: a PATH of POSIX /tmp entries splits on ":" there.
  it.skipIf(onWindows)(
    "re-binds from the PATH the child gets, not this process's",
    () => {
      // The confined child is spawned with the login shell's profile merged over
      // the caller's environment, so a /tmp entry the profile contributes is on
      // the child's PATH and nowhere in process.env — and used to be left
      // unbound, with the tools on it unreachable inside the sandbox.
      const dir = fs.mkdtempSync("/tmp/sbx-profile-");
      const previous = process.env.PATH;
      try {
        process.env.PATH = "/usr/bin";
        const args = buildArgs(
          policy({ mode: "read-only" }),
          "echo hi",
          "/tmp/ws",
          `/usr/bin:${dir}`
        ).join(" ");
        expect(args).toContain(`--ro-bind ${dir} ${dir}`);
      } finally {
        process.env.PATH = previous;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});

// Skipped on Windows: a PATH of POSIX /tmp entries splits on ":" there.
describe.skipIf(onWindows)("the /tmp PATH re-binds", () => {
  it("binds only entries under /tmp that exist, once each", () => {
    const exists = (p: string): boolean => p === "/tmp/.mount_app/vendor";
    const pathVar = [
      "/usr/bin",
      "/tmp/.mount_app/vendor",
      "/tmp/.mount_app/vendor",
      "/tmp/gone",
    ].join(":");
    expect(tmpPathBinds(pathVar, exists)).toEqual([
      "--ro-bind",
      "/tmp/.mount_app/vendor",
      "/tmp/.mount_app/vendor",
    ]);
  });

  it("never binds /tmp itself, which would defeat the tmpfs", () => {
    expect(tmpPathBinds("/tmp", () => true)).toEqual([]);
  });

  it("never binds /tmp however it is spelled", () => {
    // A raw startsWith("/tmp/") lets these through, and the resulting
    // `--ro-bind /tmp/ /tmp/` puts the host's real /tmp back over the private
    // tmpfs — read-only, so ordinary scratch writes then fail EROFS.
    for (const spelling of ["/tmp/", "/tmp/.", "/tmp/x/..", "/tmp//"])
      expect(tmpPathBinds(spelling, () => true)).toEqual([]);
  });

  it("collapses spellings of the same directory to one bind", () => {
    expect(
      tmpPathBinds("/tmp/vendor:/tmp/vendor/:/tmp/./vendor", () => true)
    ).toEqual(["--ro-bind", "/tmp/vendor", "/tmp/vendor"]);
  });

  it("is empty with no PATH at all", () => {
    expect(tmpPathBinds(undefined, () => true)).toEqual([]);
  });
});

describe("the bwrap probe", () => {
  // The probe's contract: "canary failed" only counts as confinement when the
  // same argv demonstrably runs commands. A bwrap that cannot build a
  // namespace at all (no unprivileged user namespaces) fails both runs.
  const target = "/tmp/never-written";

  it("fails when bwrap cannot run anything — the container case", () => {
    expect(runProbe("/usr/bin/bwrap", target, () => 1)).toBe(false);
  });

  it("fails when bwrap cannot even be executed", () => {
    expect(runProbe("/usr/bin/bwrap", target, () => null)).toBe(false);
  });

  it("fails when the canary write succeeds through the read-only bind", () => {
    expect(runProbe("/usr/bin/bwrap", target, () => 0)).toBe(false);
  });

  /** The control is the run that must succeed; the canary is the one that must not. */
  const isControl = (args: string[]): boolean => args.includes("exit 0");

  it("passes only when the control succeeds and the canary is refused", () => {
    const exec = (_binary: string, args: string[]): number =>
      isControl(args) ? 0 : 1;
    expect(runProbe("/usr/bin/bwrap", target, exec)).toBe(true);
  });

  it("runs the control with the same namespace flags as the canary", () => {
    const argvs: string[][] = [];
    const exec = (_binary: string, args: string[]): number => {
      argvs.push(args);
      return isControl(args) ? 0 : 1;
    };
    runProbe("/usr/bin/bwrap", target, exec);
    expect(argvs).toHaveLength(2);
    const flags = (args: string[]): string[] =>
      args.slice(0, args.indexOf("--"));
    expect(flags(argvs[1]!)).toEqual(flags(argvs[0]!));
  });

  it("exercises the same interpreter confined commands run under", () => {
    // Two things at once. It must not need a SECOND binary — /bin/true is not
    // in the bind root on a non-usr-merged NixOS, and depending on it there
    // declares a working sandbox unavailable and refuses every command. And it
    // must be the interpreter the commands themselves use: probing a different
    // one passes on a host that lacks the real one, and then every command
    // dies failing to exec with nothing to explain why.
    const argvs: string[][] = [];
    const exec = (_binary: string, args: string[]): number => {
      argvs.push(args);
      return isControl(args) ? 0 : 1;
    };
    runProbe("/usr/bin/bwrap", target, exec);

    const confined = buildArgs(policy(), "echo hi", "/tmp/ws");
    const interpreter = confined[confined.indexOf("--") + 1];

    for (const args of argvs) {
      expect(args[args.indexOf("--") + 1]).toBe(interpreter);
    }
  });

  it("counts only the deadline's own kill as a timeout", () => {
    // Every signal death read as a timeout means no verdict is ever recorded,
    // and the whole two-run probe is re-run before each command from then on.
    expect(execFailureStatus({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(execFailureStatus({ signal: "SIGTERM" })).toBe("timeout");
    expect(execFailureStatus({ signal: "SIGKILL", status: null })).toBeNull();
    expect(execFailureStatus({ signal: "SIGSYS", status: null })).toBeNull();
    expect(execFailureStatus({ status: 1 })).toBe(1);
  });

  it("gives no verdict when the control run hits the deadline", () => {
    // A cold or loaded machine is not a broken one. Reporting false here would
    // be cached for the life of the process and refuse every later command.
    expect(runProbe("/usr/bin/bwrap", target, () => "timeout")).toBeNull();
  });

  it("gives no verdict when the canary run hits the deadline", () => {
    const exec = (_binary: string, args: string[]): number | "timeout" =>
      isControl(args) ? 0 : "timeout";
    expect(runProbe("/usr/bin/bwrap", target, exec)).toBeNull();
  });

  it("still fails closed when bwrap genuinely refuses to build a namespace", () => {
    // The timeout carve-out must not soften a real failure into "undetermined".
    expect(runProbe("/usr/bin/bwrap", target, () => 1)).toBe(false);
  });
});

// Skipped on Windows: these assert bubblewrap argv built from POSIX runtime
// paths and a uid, neither of which that platform has.
describe.skipIf(onWindows)("the bus-neutralizing binds", () => {
  // The service-activation escape: a command that reaches D-Bus or the per-user
  // systemd manager over its socket can have a system service spawn a process
  // outside the sandbox. An empty tmpfs over the sockets closes it.
  it("overlays a tmpfs over the runtime dir and /run/dbus when both exist", () => {
    const exists = (p: string): boolean => p !== "/run/user/1000/gnupg";
    expect(busNeutralizingArgs("/run/user/1000", exists)).toEqual([
      "--tmpfs",
      "/run/user/1000",
      "--tmpfs",
      "/run/dbus",
    ]);
  });

  it("skips a path that is absent — a mountpoint cannot be made under a ro bind", () => {
    expect(
      busNeutralizingArgs("/run/user/1000", (p) => p === "/run/dbus")
    ).toEqual(["--tmpfs", "/run/dbus"]);
  });

  it("binds the ssh-agent socket back on top of the tmpfs, after it", () => {
    // git push over agent auth must keep working; the tmpfs alone would hide
    // the socket along with the session bus.
    const sock = "/run/user/1000/keyring/ssh";
    const args = busNeutralizingArgs(
      "/run/user/1000",
      (p) => p !== "/run/user/1000/gnupg",
      sock
    );
    expect(args).toEqual([
      "--tmpfs",
      "/run/user/1000",
      "--tmpfs",
      "/run/dbus",
      "--ro-bind",
      sock,
      sock,
    ]);
  });

  it("binds the ssh socket back when the runtime dir has a trailing slash", () => {
    // XDG_RUNTIME_DIR=/run/user/1000/ is a perfectly ordinary setting. Comparing
    // the raw strings makes the prefix "/run/user/1000//", which no real socket
    // path matches — so the socket stayed hidden and git push over agent auth
    // stayed broken.
    const sock = "/run/user/1000/keyring/ssh";
    const args = busNeutralizingArgs(
      "/run/user/1000/",
      (p) => p !== "/run/user/1000/gnupg",
      sock
    );
    expect(args.slice(-3)).toEqual(["--ro-bind", sock, sock]);
  });

  it("leaves an ssh socket outside the runtime dir alone — nothing hides it", () => {
    const args = busNeutralizingArgs(
      "/run/user/1000",
      (p) => p !== "/run/user/1000/gnupg",
      "/tmp/ssh-XYZ/agent.1"
    );
    expect(args).not.toContain("--ro-bind");
  });

  it("skips an ssh socket the environment names but that does not exist", () => {
    const args = busNeutralizingArgs(
      "/run/user/1000",
      (p) => p === "/run/user/1000" || p === "/run/dbus",
      "/run/user/1000/keyring/ssh"
    );
    expect(args).not.toContain("--ro-bind");
  });

  it("binds the gnupg agent directory back when it exists", () => {
    const args = busNeutralizingArgs("/run/user/1000", () => true);
    expect(args).toEqual([
      "--tmpfs",
      "/run/user/1000",
      "--tmpfs",
      "/run/dbus",
      "--ro-bind",
      "/run/user/1000/gnupg",
      "/run/user/1000/gnupg",
    ]);
  });

  it("never binds the session bus socket back", () => {
    // The bus is the escape the tmpfs exists to close; the agent re-binds
    // must not reopen it.
    const args = busNeutralizingArgs("/run/user/1000", () => true).join(" ");
    expect(args).not.toContain("--ro-bind /run/user/1000/bus");
  });

  it("derives an absolute runtime dir even with no XDG_RUNTIME_DIR set", () => {
    const previous = process.env.XDG_RUNTIME_DIR;
    try {
      delete process.env.XDG_RUNTIME_DIR;
      expect(path.isAbsolute(xdgRuntimeDir())).toBe(true);
      expect(xdgRuntimeDir()).toMatch(/^\/run\/user\/\d+$/);
    } finally {
      if (previous == null) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it("prefers an absolute XDG_RUNTIME_DIR when the environment sets one", () => {
    const previous = process.env.XDG_RUNTIME_DIR;
    try {
      process.env.XDG_RUNTIME_DIR = "/run/user/4242";
      expect(xdgRuntimeDir()).toBe("/run/user/4242");
    } finally {
      if (previous == null) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it("puts the neutralizing binds into buildArgs when the sockets exist on this host", () => {
    // Host-dependent, so only assert where the runtime dir is actually present
    // (a Linux session). Elsewhere the derivation and gating are covered above.
    const dir = xdgRuntimeDir();
    if (!fs.existsSync(dir) && !fs.existsSync("/run/dbus")) return;
    const args = buildArgs(policy(), "echo hi", "/tmp/ws").join(" ");
    if (fs.existsSync(dir)) expect(args).toContain(`--tmpfs ${dir}`);
    if (fs.existsSync("/run/dbus")) expect(args).toContain("--tmpfs /run/dbus");
  });
});

// ---------------------------------------------------------------------------
// Live confinement. macOS only — see the file header.
// ---------------------------------------------------------------------------

describe.runIf(onMac)("confinement against the real kernel", () => {
  let workspace: string;
  let outsideDir: string;
  let outside: string;

  beforeAll(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-live-"))
    );
    outsideDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-out-"))
    );
    outside = path.join(outsideDir, "should-not-exist.txt");
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  /** Run `command` under the profile the given mode would produce. */
  function run(
    command: string,
    mode: SandboxPolicy["mode"] = "workspace-write"
  ): number {
    const decision = decide(
      policy({ mode, workspaceRoot: workspace }),
      command,
      workspace
    );
    if (decision.kind !== "confined")
      throw new Error(`expected confinement, got ${decision.kind}`);

    try {
      execFileSync(decision.argv[0]!, decision.argv.slice(1), {
        cwd: workspace,
        stdio: "ignore",
        timeout: 20_000,
      });

      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  }

  it("permits a write inside the workspace", () => {
    expect(run("echo written > inside.txt")).toBe(0);
    expect(fs.existsSync(path.join(workspace, "inside.txt"))).toBe(true);
  });

  it("refuses a write outside it, and leaves no file behind", () => {
    fs.rmSync(outside, { force: true });
    expect(run(`echo pwned > ${JSON.stringify(outside)}`)).not.toBe(0);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("leaves reads alone", () => {
    expect(run("ls / > /dev/null")).toBe(0);
  });

  it("does not break an ordinary toolchain", () => {
    // A sandbox that blocks compilers gets switched off, which protects nobody.
    expect(run("node --version > /dev/null && git --version > /dev/null")).toBe(
      0
    );
  });

  it("blocks writes to the workspace itself in read-only mode", () => {
    expect(run("echo nope > ro.txt", "read-only")).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, "ro.txt"))).toBe(false);
  });

  it("still allows a write to temp in read-only mode", () => {
    // Plan mode is read-only for the workspace but must keep a writable
    // scratch, or ordinary tools that touch a temp file fail outright.
    const target = path.join(
      "/private/tmp",
      `sbx-ro-${process.pid}-${Date.now()}.txt`
    );
    fs.rmSync(target, { force: true });
    expect(run(`echo ok > ${JSON.stringify(target)}`, "read-only")).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(target, { force: true });
  });

  describe("evasions that defeat pattern matching", () => {
    // Each of these gets past a regex deny-list. None of them gets past the
    // kernel — which is the entire argument for having a sandbox at all.
    it.each([
      [
        "a base64-decoded script",
        (out: string) =>
          `echo ${Buffer.from(`echo pwned > ${out}`).toString("base64")} | base64 -d | bash`,
      ],
      [
        "a heredoc written to a file and run",
        (out: string) =>
          `cat <<'EOS' > s.sh\necho pwned > ${out}\nEOS\nbash s.sh`,
      ],
      ["tee", (out: string) => `echo pwned | tee ${out}`],
      [
        "python",
        (out: string) => `python3 -c "open('${out}','w').write('pwned')"`,
      ],
    ])("cannot write outside via %s", (_label, build) => {
      fs.rmSync(outside, { force: true });
      run(build(outside));
      expect(fs.existsSync(outside)).toBe(false);
    });
  });

  describe("the LaunchServices escape", () => {
    // Regression test for the hole the review found: Seatbelt is inherited
    // across fork and exec, but a process launchd starts on our behalf is not
    // a child and begins with no sandbox at all.
    //
    // The positive control below is what makes this test worth having. An
    // assertion that a file did NOT appear passes for every reason the escape
    // failed to be attempted at all — no Aqua session on a CI runner, a slow
    // machine, LaunchServices declining the bundle. So we first prove the
    // bundle DOES run when nothing is stopping it. If it does not, the
    // environment cannot exercise this path and the test says so instead of
    // reporting a green it has not earned.
    let launchWorks = false;

    function buildAppBundle(name: string): string {
      const app = path.join(workspace, `${name}.app`);
      fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
      fs.writeFileSync(
        path.join(app, "Contents/Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>esc</string>
<key>CFBundleIdentifier</key><string>com.abacusai.sandboxtest.${name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`
      );
      const exe = path.join(app, "Contents/MacOS/esc");
      fs.writeFileSync(exe, `#!/bin/bash\necho ESCAPED > ${outside}\n`);
      fs.chmodSync(exe, 0o755);

      return app;
    }

    /** Wait for the payload, rather than assuming a fixed delay is enough. */
    async function payloadLanded(timeoutMs = 8_000): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (fs.existsSync(outside)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      return false;
    }

    beforeAll(async () => {
      // The control: launch the bundle with no sandbox at all. If this does
      // not fire, LaunchServices is unavailable here and the confinement
      // assertions below would be vacuous.
      const app = buildAppBundle("Control");
      fs.rmSync(outside, { force: true });
      try {
        execFileSync("/usr/bin/open", ["-g", app], {
          stdio: "ignore",
          timeout: 20_000,
        });
      } catch {
        // Fall through — payloadLanded decides.
      }
      launchWorks = await payloadLanded();
      fs.rmSync(outside, { force: true });
    });

    it("can launch a bundle at all when nothing is stopping it", () => {
      // Not a security assertion. It is the guard that stops the two tests
      // below from passing for the wrong reason, and it fails loudly on an
      // environment where they cannot mean anything.
      expect(
        launchWorks,
        "LaunchServices could not launch a test bundle, so the escape tests below prove nothing here"
      ).toBe(true);
    });

    it("cannot escape by asking launchd to run a bundle from the workspace", async () => {
      if (!launchWorks) return;
      const app = buildAppBundle("Esc");
      fs.rmSync(outside, { force: true });

      run(`open -g ${JSON.stringify(app)}`);

      expect(await payloadLanded()).toBe(false);
    });

    it("cannot escape with a copied binary either", async () => {
      // Copying defeats the process-exec rule, so this is the case only the
      // mach-lookup denial can stop. It does not run everywhere: `open` is a
      // signed platform binary, and on a Mac enforcing that, the copy is
      // SIGKILLed before it asks anything — the test then passes without the
      // sandbox doing the work. CI runners do not enforce it and this is a real
      // attempt there. The test below is the one that means something on both.
      if (!launchWorks) return;
      const app = buildAppBundle("Copied");
      fs.rmSync(outside, { force: true });

      run(
        `cp /usr/bin/open ./myopen 2>/dev/null; ./myopen -g ${JSON.stringify(app)}`
      );

      expect(await payloadLanded()).toBe(false);
    });

    it("is stopped by the service denial alone, not just by the exec denial", async () => {
      // The regression the enumerated deny-list shipped with: `open` reached
      // LaunchServices through a service the list did not name, and only the
      // process-exec rule was stopping it — which a copied binary walks past.
      // Strip that rule and the mach-lookup half has to hold on its own.
      //
      // Uses the real `open`, so unlike the copied-binary case this is a
      // genuine attempt on a developer Mac as well as on CI.
      if (!launchWorks) return;
      const app = buildAppBundle("NoExec");
      fs.rmSync(outside, { force: true });

      const lines = buildProfile(policy({ workspaceRoot: workspace })).split(
        "\n"
      );
      const start = lines.findIndex((line) =>
        line.startsWith("(deny process-exec*")
      );
      expect(
        start,
        "the process-exec rule this test strips has moved"
      ).toBeGreaterThan(-1);
      const end = lines.findIndex(
        (line, index) => index >= start && line.endsWith("))")
      );
      const stripped = [...lines.slice(0, start), ...lines.slice(end + 1)].join(
        "\n"
      );

      try {
        execFileSync(
          "/usr/bin/sandbox-exec",
          ["-p", stripped, "/usr/bin/open", "-g", app],
          {
            cwd: workspace,
            stdio: "ignore",
            timeout: 20_000,
          }
        );
      } catch {
        // A refusal is the good outcome; payloadLanded decides.
      }

      expect(await payloadLanded()).toBe(false);
    });

    afterAll(() => {
      // Leave no bundle registered with LaunchServices. A stale registration
      // means any account that later recreates the path gets a bundle
      // launchable by id.
      const lsregister =
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
      for (const name of ["Control", "Esc", "Copied", "NoExec"]) {
        try {
          execFileSync(
            lsregister,
            ["-u", path.join(workspace, `${name}.app`)],
            {
              stdio: "ignore",
              timeout: 10_000,
            }
          );
        } catch {
          // Best effort; the bundle directory goes with the temp workspace.
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Live bus confinement. Linux only, and only where bwrap can actually build a
// namespace here — same skip-on-no-backend idiom as the macOS suite above, so
// a runner without unprivileged user namespaces stays green rather than red.
// ---------------------------------------------------------------------------

describe.runIf(onLinux)("bus confinement against the real kernel", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "sbx-bus-"))
    );
  });

  afterAll(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  /** Run under confinement; -1 means no usable backend, so the caller skips. */
  function run(command: string): number {
    const decision = decide(
      policy({ mode: "workspace-write", workspaceRoot: workspace }),
      command,
      workspace
    );
    if (decision.kind !== "confined") return -1;

    try {
      execFileSync(decision.argv[0]!, decision.argv.slice(1), {
        cwd: workspace,
        stdio: "ignore",
        timeout: 20_000,
      });

      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  }

  it("hides the session bus socket inside the sandbox", () => {
    const busPath = path.join(xdgRuntimeDir(), "bus");
    // Only meaningful where the host actually has a session bus to hide; a
    // headless runner has none, and this self-skips rather than passing hollow.
    if (!fs.existsSync(busPath)) return;

    // `test ! -S` succeeds (exit 0) only when the socket is gone — which is
    // what the tmpfs overlay makes true inside the sandbox.
    const code = run(`test ! -S ${JSON.stringify(busPath)}`);
    if (code === -1) return;
    expect(code).toBe(0);
  });

  it("cannot reach the user systemd manager to spawn a unit", () => {
    // The escape itself: if the manager were reachable this would start `true`
    // as an unconfined transient unit and exit 0. With the socket gone it
    // cannot connect. (On a runner with no user manager it also fails, for a
    // duller reason — the assertion is one-directional on purpose.)
    const code = run("systemd-run --user --quiet --wait true");
    if (code === -1) return;
    expect(code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Live credential hiding, on either backend. A fake home stands in for the
// real one so the test never touches actual keys.
// ---------------------------------------------------------------------------

describe.runIf(onMac || onLinux)(
  "credential stores against the real kernel",
  () => {
    let workspace: string;
    let home: string;
    let key: string;
    let config: string;
    let netrc: string;

    beforeAll(() => {
      workspace = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "sbx-secret-ws-"))
      );
      home = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "sbx-secret-home-"))
      );
      fs.mkdirSync(path.join(home, ".ssh"));
      key = path.join(home, ".ssh", "id_ed25519");
      config = path.join(home, ".ssh", "config");
      netrc = path.join(home, ".netrc");
      fs.writeFileSync(key, "PRIVATE\n");
      fs.writeFileSync(config, "Host example\n");
      fs.writeFileSync(netrc, "password hunter2\n");
    });

    afterAll(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    /** Exit code under confinement, or -1 when no backend can be established. */
    function run(command: string, approved: string[] = []): number {
      const decision = decide(
        policy({
          workspaceRoot: workspace,
          writableTemp: [canonicalize(os.tmpdir())],
          secrets: resolveSecretPaths({
            home,
            workspaceRoot: workspace,
            exemptions: approved,
          }),
        }),
        command,
        workspace
      );
      if (decision.kind !== "confined") return -1;

      try {
        execFileSync(decision.argv[0]!, decision.argv.slice(1), {
          cwd: workspace,
          stdio: "ignore",
          timeout: 20_000,
        });

        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? 1;
      }
    }

    it("cannot read a private key", () => {
      // Bubblewrap serves an empty tmpfs, Seatbelt refuses the open; either way
      // the contents never come out.
      const code = run(
        `test ! -s ${JSON.stringify(key)} || ! cat ${JSON.stringify(key)}`
      );
      if (code === -1) return;
      expect(code).toBe(0);
    });

    it("cannot read a credential file", () => {
      const code = run(`grep -q hunter2 ${JSON.stringify(netrc)}`);
      if (code === -1) return;
      expect(code).not.toBe(0);
    });

    it("still reads the ssh config beside the key", () => {
      const code = run(`grep -q example ${JSON.stringify(config)}`);
      if (code === -1) return;
      expect(code).toBe(0);
    });

    it("reads the key once the user approved it on the card", () => {
      const code = run(`grep -q PRIVATE ${JSON.stringify(key)}`, [key]);
      if (code === -1) return;
      expect(code).toBe(0);
    });

    it("cannot get around it by copying into the workspace", () => {
      const code = run(
        `cp ${JSON.stringify(key)} ./stolen && grep -q PRIVATE ./stolen`
      );
      if (code === -1) return;
      expect(code).not.toBe(0);
    });
  }
);

/**
 * The default, which nothing pinned before.
 *
 * It is the whole contract of this switch: off unless something asks, so a
 * change of heart about it has to be deliberate rather than a one-word edit
 * that no test notices.
 */
describe("enforcement default", () => {
  const previous = process.env.ABACUSAI_BOT_SANDBOX;

  afterEach(() => {
    if (previous == null) delete process.env.ABACUSAI_BOT_SANDBOX;
    else process.env.ABACUSAI_BOT_SANDBOX = previous;
  });

  it("is off when nothing sets it", () => {
    delete process.env.ABACUSAI_BOT_SANDBOX;
    expect(sandboxEnforcement()).toBe("off");
  });

  it("is off for a value it does not recognise, rather than guessing", () => {
    // Silently reading an unknown value as "on" would tell the user they have
    // confinement they never asked for; as "off" it matches the default.
    process.env.ABACUSAI_BOT_SANDBOX = "yes-please";
    expect(sandboxEnforcement()).toBe("off");
  });

  it("turns on for what the desktop toggle writes, and its plain synonyms", () => {
    for (const value of ["auto", "1", "true", "AUTO"]) {
      process.env.ABACUSAI_BOT_SANDBOX = value;
      expect(sandboxEnforcement()).toBe("auto");
    }
  });

  it("still honours strict, which refuses rather than degrades", () => {
    process.env.ABACUSAI_BOT_SANDBOX = "strict";
    expect(sandboxEnforcement()).toBe("strict");
  });

  it("an unconfined decision follows from the default alone", () => {
    // The end-to-end statement: with nothing set, a command is not confined.
    delete process.env.ABACUSAI_BOT_SANDBOX;
    const policy = resolvePolicy(AgentMode.Normal, process.cwd());

    expect(policy.enforcement).toBe("off");
    expect(decide(policy, "echo hi", process.cwd())).toEqual({
      kind: "unconfined",
      reason: "mode",
    });
  });
});
