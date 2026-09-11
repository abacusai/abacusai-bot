/**
 * Linux confinement via bubblewrap (`bwrap`). The policy is expressed as
 * mounts: the filesystem bound read-only, the directories the mode permits
 * re-bound writable on top, so a write outside them is an EROFS from the
 * kernel. Chosen over Landlock because it needs no native module; probed
 * rather than assumed.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SandboxPolicy } from "./policy.js";
import { POSIX_SHELL, shellArgs } from "./shell.js";

/**
 * This user's runtime directory as the session bus and per-user systemd find
 * it: $XDG_RUNTIME_DIR, else systemd's own fallback /run/user/<uid>.
 */
export function xdgRuntimeDir(): string {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv != null && path.isAbsolute(fromEnv)) return fromEnv;

  const uid =
    typeof process.getuid === "function" ? process.getuid() : os.userInfo().uid;

  return `/run/user/${uid}`;
}

/**
 * Empty tmpfs over the D-Bus and service-manager sockets, so a command cannot
 * have systemd or D-Bus spawn an unconfined process on its behalf
 * (`systemd-run --user`, StartTransientUnit); --unshare-ipc does not cover
 * AF_UNIX sockets reachable through the root bind. The session bus and the
 * per-user systemd socket both live under $XDG_RUNTIME_DIR; /run/dbus is the
 * system bus. Only existing paths are overlaid, since a new mountpoint cannot
 * be made under a read-only bind and bwrap would fail outright. /run/systemd
 * is left alone (systemd-resolved serves DNS from there). The ssh-agent socket
 * and gpg-agent dir are bound back read-only so `git push` and signed commits
 * keep working.
 */
export function busNeutralizingArgs(
  runtimeDir: string,
  exists: (candidate: string) => boolean,
  sshAuthSock?: string
): string[] {
  const args: string[] = [];
  for (const target of [runtimeDir, "/run/dbus"]) {
    if (exists(target)) args.push("--tmpfs", target);
  }

  if (!exists(runtimeDir)) return args;

  // Normalized: a trailing slash on XDG_RUNTIME_DIR would make the prefix
  // "/run/user/1000//" and nothing would match.
  const normalizedDir = path.resolve(runtimeDir);
  if (sshAuthSock != null && sshAuthSock.length > 0) {
    const sock = path.resolve(sshAuthSock);
    if (sock.startsWith(normalizedDir + path.sep) && exists(sshAuthSock))
      args.push("--ro-bind", sshAuthSock, sshAuthSock);
  }

  const gnupg = path.join(runtimeDir, "gnupg");
  if (exists(gnupg)) args.push("--ro-bind", gnupg, gnupg);

  return args;
}

/**
 * Read-only re-binds for PATH entries under /tmp. Read-only mode's private
 * tmpfs also masks an AppImage's `/tmp/.mount_*`, where the vendored rg/fd on
 * the sandbox PATH live (see bundled-tools.ts).
 */
export function tmpPathBinds(
  pathVar: string | undefined,
  exists: (candidate: string) => boolean
): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  for (const entry of (pathVar ?? "").split(":")) {
    if (entry.length === 0) continue;
    // "/tmp/." and "/tmp/x/.." name /tmp itself, and binding that would put
    // the host's real /tmp back over the private tmpfs, read-only.
    const resolved = path.resolve(entry);
    if (resolved === "/tmp" || !resolved.startsWith("/tmp/")) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (exists(resolved)) args.push("--ro-bind", resolved, resolved);
  }

  return args;
}

export function buildArgs(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  // The child's PATH, not this process's: the caller merges the login shell's
  // profile over it, and a /tmp entry from there must still be bound back.
  childPath: string | undefined = process.env.PATH
): string[] {
  const args = [
    // Everything readable, nothing writable, until stated otherwise below.
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    // --unshare-pid is mandatory next to --proc: with host processes visible,
    // /proc/<pid>/root resolves in THAT process's mount namespace, so a write
    // through the same-uid app process reaches the host's read-write mount.
    "--unshare-pid",
    "--proc",
    "/proc",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--die-with-parent",
    // Detached from the controlling terminal so a command cannot reach the tty.
    "--new-session",
  ];

  // Applied in both modes: read-only is escaped the same way.
  args.push(
    ...busNeutralizingArgs(
      xdgRuntimeDir(),
      fs.existsSync,
      process.env.SSH_AUTH_SOCK
    )
  );

  if (policy.mode === "workspace-write") {
    args.push("--bind", policy.workspaceRoot, policy.workspaceRoot);
    for (const temp of policy.writableTemp) {
      args.push("--bind", temp, temp);
    }
  } else {
    // Even read-only needs scratch space, or ordinary tools fail on their
    // first temp file; a private tmpfs gives it without exposing the real /tmp.
    args.push("--tmpfs", "/tmp");
    args.push(...tmpPathBinds(childPath, fs.existsSync));
  }

  args.push("--chdir", cwd, "--", POSIX_SHELL, ...shellArgs(command));

  return args;
}

/**
 * Never resolved through PATH: a project-relative bin directory is an ordinary
 * developer setup, and a planted `bwrap` that executes its last argument would
 * satisfy the probe and confine nothing.
 */
const BWRAP_CANDIDATES = [
  "/usr/bin/bwrap",
  "/bin/bwrap",
  "/usr/local/bin/bwrap",
];

function bwrapPath(): string | null {
  for (const candidate of BWRAP_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
      // Try the next one.
    }
  }

  return null;
}

/** Argv that runs `command` under bwrap, or null when unavailable. */
export function wrap(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  childPath?: string
): string[] | null {
  const binary = bwrapPath();
  if (binary === null || !probe()) return null;

  return [binary, ...buildArgs(policy, command, cwd, childPath)];
}

let probed: boolean | undefined;

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Exit status of `binary args...`; "timeout" when killed by the deadline, null
 * when it could not start. Distinct because a timeout says something about the
 * machine, not bwrap, and folding it into failure refuses every command on a
 * working host.
 */
type ExecStatus = (binary: string, args: string[]) => number | "timeout" | null;

/**
 * execFileSync enforces the deadline with SIGTERM, so that signal is the
 * timeout evidence. Any other signal (OOM killer, an LSM) is a real verdict
 * about this host; reading it as a timeout would re-run the probe before every
 * command.
 */
export function execFailureStatus(failure: {
  code?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
}): number | "timeout" | null {
  if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM")
    return "timeout";

  return typeof failure.status === "number" ? failure.status : null;
}

const execStatus: ExecStatus = (binary, args) => {
  try {
    execFileSync(binary, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });

    return 0;
  } catch (error) {
    return execFailureStatus(
      error as NodeJS.ErrnoException & {
        status?: number | null;
        signal?: NodeJS.Signals | null;
      }
    );
  }
};

/** The namespace flags real commands get; the probe must use the same ones. */
const PROBE_ARGS = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--unshare-pid",
  "--proc",
  "/proc",
  "--die-with-parent",
];

/**
 * Two runs, because one cannot tell "the write was refused" from "bwrap could
 * not build a namespace at all" (no unprivileged user namespaces): a control
 * run that must succeed comes first. Both use the interpreter confined
 * commands run under, so the probe answers the same question they will ask
 * (/bin/true is absent on a non-usr-merged NixOS). Null on a timeout: not a
 * verdict.
 */
export function runProbe(
  binary: string,
  target: string,
  exec: ExecStatus = execStatus
): boolean | null {
  const control = exec(binary, [
    ...PROBE_ARGS,
    "--",
    POSIX_SHELL,
    "-c",
    "exit 0",
  ]);
  if (control === "timeout") return null;
  if (control !== 0) return false;

  const canary = exec(binary, [
    ...PROBE_ARGS,
    "--",
    POSIX_SHELL,
    "-c",
    `touch ${JSON.stringify(target)} 2>/dev/null`,
  ]);
  if (canary === "timeout") return null;

  // Only a real refusal counts: 0 means the write went through, null means
  // bwrap could not run.
  return canary !== null && canary !== 0;
}

/**
 * Confirm bwrap can actually create a namespace here: on hardened kernels and
 * in some container runtimes it exists and fails at run time.
 */
export function probe(): boolean {
  if (probed !== undefined) return probed;

  const binary = bwrapPath();
  if (binary === null) {
    probed = false;

    return probed;
  }

  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-probe-"));
  } catch {
    probed = false;

    return probed;
  }

  const target = path.join(dir, "canary");

  let result = runProbe(binary, target);

  if (result === true) {
    try {
      if (fs.existsSync(target)) result = false;
    } catch {
      result = false;
    }
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Not worth failing over.
  }

  // A timeout is not a verdict: refuse this command (unproven means no) but
  // leave the cache unset so one slow moment is not a session-long refusal.
  if (result === null) return false;

  probed = result;

  return probed;
}
