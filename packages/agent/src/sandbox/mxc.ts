/**
 * Windows confinement via Microsoft eXecution Containers (`wxc-exec.exe`, the
 * runner behind @microsoft/mxc-sdk). The policy is a JSON config handed over
 * as one base64 argument, so the backend produces an argv like the other two;
 * the SDK itself is not used, since it would bring node-pty and 60 MB of
 * binaries for every platform. Needs Windows 11 24H2 (build 26100) or newer.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bundledToolsDir } from "../bundled-tools.js";
import { MINIMUM_WINDOWS_BUILD, windowsBuild } from "../sandbox-support.js";
import type { SandboxPolicy } from "./policy.js";
import { probeVerdict, type ProbeExec } from "./probe.js";
import type { SecretPaths } from "./secrets.js";

/** `isWithin` for Windows paths: backslashes, and case does not matter. */
function withinWin32(child: string, parent: string): boolean {
  const relative = path.win32.relative(
    parent.toLowerCase(),
    child.toLowerCase()
  );

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.win32.isAbsolute(relative))
  );
}

/** Whether this Windows build can host a process container. */
export function buildSupported(release: string = os.release()): boolean {
  return windowsBuild(release) >= MINIMUM_WINDOWS_BUILD;
}

/**
 * The runner, never resolved through PATH: a planted `wxc-exec.exe` beside a
 * project would satisfy the probe and confine nothing. The shipped copy lives
 * in vendor/ beside the agent (download-tools.js); ABACUSAI_BOT_MXC_EXEC
 * points a development checkout at one.
 */
export function runnerPath(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const configured = (env.ABACUSAI_BOT_MXC_EXEC ?? "").trim();
  const candidates = [
    ...(configured.length > 0 ? [configured] : []),
    path.join(bundledToolsDir(), "mxc", "wxc-exec.exe"),
  ];

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);

      return candidate;
    } catch {
      // Try the next one.
    }
  }

  return null;
}

/** The drive roots reads are allowed from: everything, like the other backends. */
export function driveRoots(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const roots = new Set<string>();
  for (const drive of [env.SystemDrive, env.HOMEDRIVE]) {
    if (drive != null && /^[A-Za-z]:$/.test(drive)) roots.add(`${drive}\\`);
  }
  for (const candidate of paths) {
    const root = path.win32.parse(candidate).root;
    if (root.length > 0) roots.add(root);
  }

  return [...roots];
}

/**
 * The runner's `deniedPaths` win over every allow, so a directory with files
 * read back (`~/.ssh` and its config) cannot be denied whole. Its other
 * children are denied one by one instead.
 */
export function deniedPaths(
  secrets: Pick<SecretPaths, "denied" | "allowed">,
  list: (dir: string) => string[]
): string[] {
  const denied: string[] = [];
  for (const store of secrets.denied) {
    const readBack = secrets.allowed.filter((file) => withinWin32(file, store));
    if (readBack.length === 0) {
      denied.push(store);
      continue;
    }

    for (const name of list(store)) {
      const child = path.win32.join(store, name);
      if (!readBack.some((file) => withinWin32(file, child)))
        denied.push(child);
    }
  }

  return denied;
}

function listSync(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The runner's config for one command. Exported for the tests. */
export function buildConfig(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const writable = [
    ...(policy.mode === "workspace-write" ? [policy.workspaceRoot] : []),
    ...policy.writableTemp,
    ...policy.approvedWrites,
  ];
  const denied = deniedPaths(policy.secrets, listSync);

  return {
    version: "0.8.0-alpha",
    containment: "processcontainer",
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: {
      // cmd.exe, as the unconfined path uses; /d skips AutoRun, /s keeps the
      // quoting predictable. ComSpec carries no space, which the runner's
      // parser refuses in an unquoted program path.
      commandLine: `${env.ComSpec ?? "cmd.exe"} /d /s /c "${command}"`,
      cwd,
    },
    filesystem: {
      readonlyPaths: driveRoots([cwd, policy.workspaceRoot], env),
      readwritePaths: writable,
      deniedPaths: denied,
    },
    // Network is not confined here, as on the other platforms; the runner
    // defaults to deny when the block is absent.
    network: {
      egress: { default: "allow" },
      ingress: { default: "allow", hostLoopback: "allow" },
    },
    ui: { disable: true, clipboard: "none", injection: false },
    processContainer: {},
  };
}

function configArgs(config: Record<string, unknown>): string[] {
  return [
    "--config-base64",
    Buffer.from(JSON.stringify(config), "utf8").toString("base64"),
  ];
}

/** Argv that runs `command` in a container, or null when unavailable. */
export function wrap(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv
): string[] | null {
  const runner = runnerPath();
  if (runner === null || !probe()) return null;

  return [runner, ...configArgs(buildConfig(policy, command, cwd, env))];
}

let probed: boolean | undefined;

/** A minimal container: reads everywhere, writes only under `writable`. */
function probeConfig(
  commandLine: string,
  writable: string,
  env: NodeJS.ProcessEnv
): Record<string, unknown> {
  return {
    version: "0.8.0-alpha",
    containment: "processcontainer",
    lifecycle: { destroyOnExit: true, preservePolicy: false },
    process: { commandLine, cwd: writable },
    filesystem: {
      readonlyPaths: driveRoots([writable], env),
      readwritePaths: [writable],
      deniedPaths: [],
    },
    network: { egress: { default: "deny" }, ingress: { default: "deny" } },
    ui: { disable: true, clipboard: "none", injection: false },
    processContainer: {},
  };
}

/**
 * Two runs, like bubblewrap's: a control that must succeed tells "the write
 * was refused" apart from "no container could be made" (an older build, a
 * disabled feature). Null on a timeout: not a verdict.
 */
export function runProbe(
  runner: string,
  writable: string,
  target: string,
  exec?: ProbeExec,
  env: NodeJS.ProcessEnv = process.env
): boolean | null {
  const shell = env.ComSpec ?? "cmd.exe";
  const control = [
    runner,
    ...configArgs(probeConfig(`${shell} /d /s /c "exit 0"`, writable, env)),
  ];
  const canary = [
    runner,
    ...configArgs(
      probeConfig(`${shell} /d /s /c "echo x > \\"${target}\\""`, writable, env)
    ),
  ];

  return probeVerdict(control, canary, exec);
}

/** Confirm the runner confines here, not merely that it exists. */
export function probe(): boolean {
  if (probed !== undefined) return probed;

  const runner = runnerPath();
  if (runner === null) {
    probed = false;

    return probed;
  }

  let writable: string;
  let outside: string;
  try {
    writable = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-probe-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-canary-"));
  } catch {
    probed = false;

    return probed;
  }

  const target = path.join(outside, "canary");
  let result = runProbe(runner, writable, target);

  if (result === true) {
    try {
      if (fs.existsSync(target)) result = false;
    } catch {
      result = false;
    }
  }

  for (const dir of [writable, outside]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Not worth failing over.
    }
  }

  if (result === null) return false;

  probed = result;

  return probed;
}
