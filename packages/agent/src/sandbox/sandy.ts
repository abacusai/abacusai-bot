/** Windows AppContainer confinement through the bundled Sandy CLI. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bundledToolsDir } from "../bundled-tools.js";
import {
  posixShell,
  posixShellEnv,
  type PosixShell,
} from "../posix-shell-install.js";
import type { Denial } from "./approvals.js";
import { canonicalize, type SandboxPolicy } from "./policy.js";
import { isWithin } from "./secrets.js";

export function runnerPath(): string | null {
  const runner = path.join(bundledToolsDir(), "sandy.exe");
  return fs.existsSync(runner) ? runner : null;
}

/** Only existing paths can be granted by Sandy. Never silently widen a grant. */
function existing(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.filter((target) => fs.existsSync(target)).map(canonicalize)
    ),
  ];
}

/**
 * AppContainer has no reliable deny rules. Do not grant a tree containing a
 * protected store; the caller must narrow it or explicitly approve that store.
 */
function checkGrants(paths: readonly string[], policy: SandboxPolicy): void {
  for (const target of paths) {
    if (
      policy.secrets.denied.some(
        (secret) =>
          isWithin(secret, target) ||
          (isWithin(target, secret) &&
            ![...policy.secrets.allowed, ...(policy.approvedReads ?? [])].some(
              (allowed) => isWithin(target, allowed)
            ))
      )
    ) {
      throw new Error(
        `Sandy cannot grant ${target} while protecting a credential store inside it. Choose a narrower path.`
      );
    }
  }
}

export function buildConfig(
  policy: SandboxPolicy,
  cwd: string,
  shell: PosixShell,
  scratch: string,
  env: NodeJS.ProcessEnv
): string {
  if (policy.network.kind !== "open")
    throw new Error("Sandy cannot enforce per-host network permissions.");
  const home = env.USERPROFILE ?? os.homedir();
  const read = existing([
    ...(policy.approvedReads ?? []),
    ...policy.secrets.allowed,
    env.GIT_CONFIG_GLOBAL ?? path.join(home, ".gitconfig"),
    path.join(
      env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
      "git",
      "config"
    ),
  ]);
  const execute = existing([shell.bin, policy.workspaceRoot]);
  const write = existing([
    scratch,
    ...(policy.mode === "workspace-write" ? [policy.workspaceRoot] : []),
    ...policy.approvedWrites,
  ]);
  for (const target of policy.approvedWrites) {
    if (!fs.existsSync(target))
      throw new Error(
        `Sandy requires approval for an existing parent directory to create ${target}.`
      );
  }
  checkGrants([...read, ...execute, ...write], policy);
  return [
    "[sandbox]",
    "token = 'appcontainer'",
    `workdir = ${JSON.stringify(cwd)}`,
    "[allow.deep]",
    `read = ${JSON.stringify(read.filter((target) => ![...execute, ...write].some((parent) => isWithin(target, parent))))}`,
    `execute = ${JSON.stringify(execute.filter((target) => !write.some((parent) => isWithin(target, parent))))}`,
    `all = ${JSON.stringify(write)}`,
    "[environment]",
    "inherit = true",
    // No host allowlist is claimed: Windows internet is open by user choice.
    "[privileges]",
    "network = true",
    "lan = false",
    "stdin = false",
    "clipboard_read = false",
    "clipboard_write = false",
    "child_processes = true",
  ].join("\n");
}

export interface SandyLaunch {
  argv: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
  /** Translate the sandbox drive in diagnostics back to the user's workspace. */
  denials: (stderr: string) => Denial[];
}

/**
 * Git's GetLongPathName lookup needs inaccessible ancestor listings. A SUBST
 * root avoids granting those ancestors. It grants no filesystem permissions.
 */
export function prepare(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  shell: PosixShell | undefined = posixShell()
): SandyLaunch {
  const runner = runnerPath();
  if (runner == null)
    throw new Error("The bundled Sandy runner is missing; reinstall the app.");
  if (shell == null)
    throw new Error("The bundled BusyBox shell is unavailable.");
  const workspace = canonicalize(cwd);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-sandy-"));
  const subst = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "subst.exe"
  );
  let drive: string | undefined;
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    if (drive != null) {
      // Never remove a mapping somebody else replaced while the command ran.
      try {
        if (
          canonicalize(`${drive}\\`).toLowerCase() === workspace.toLowerCase()
        )
          spawnSync(subst, [drive, "/D"], {
            timeout: 5000,
            windowsHide: true,
            stdio: "ignore",
          });
      } catch {
        /* already removed */
      }
    }
    // Also recovers per-instance ACLs after a timeout killed the runner. Sandy
    // checks process liveness and leaves concurrent live sandboxes alone.
    spawnSync(runner, ["--cleanup", "-q"], {
      timeout: 10000,
      windowsHide: true,
      stdio: "ignore",
    });
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    for (const letter of "ZYXWVUTSRQPONMLKJIHGFE") {
      const candidate = `${letter}:`;
      const mounted = spawnSync(subst, [candidate, workspace], {
        timeout: 5000,
        windowsHide: true,
        stdio: "ignore",
      });
      if (mounted.status === 0) {
        drive = candidate;
        break;
      }
    }
    if (drive == null)
      throw new Error(
        "No unused drive letter is available for the Windows sandbox."
      );
    const config = buildConfig(policy, `${drive}\\`, shell, scratch, env);
    const mappedDrive = drive;
    return {
      argv: [runner, "-q", "-s", config, "-x", shell.sh, "-c", command],
      env: posixShellEnv(
        { ...env, TEMP: scratch, TMP: scratch, TMPDIR: scratch },
        shell
      ),
      cleanup,
      denials: (stderr) => diagnosticDenials(stderr, mappedDrive, workspace),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Explicit diagnostics are requests for a card, never authorization themselves. */
export function diagnosticDenials(
  stderr: string,
  drive?: string,
  workspace?: string
): Denial[] {
  const denials: Denial[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match =
      /\b(can't create|can't open|Unable to create|unable to access|cannot remove) (.+): (?:Permission denied|Access is denied)\.?$/i.exec(
        line
      );
    if (match == null) continue;
    const kind = /create|remove/i.test(match[1]!) ? "write" : "read";
    let target = match[2]!;
    if (
      (target.startsWith("'") && target.endsWith("'")) ||
      (target.startsWith('"') && target.endsWith('"'))
    )
      target = target.slice(1, -1);
    // A relative diagnostic could follow a `cd`; don't guess its location.
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(target)) continue;
    if (
      drive != null &&
      workspace != null &&
      target.slice(0, 2).toLowerCase() === drive.toLowerCase()
    )
      target = path.win32.join(workspace, target.slice(3));
    target = canonicalize(target);
    if (kind === "write") {
      // Show the directory that will actually be granted for a new file.
      while (!fs.existsSync(target) && path.dirname(target) !== target)
        target = path.dirname(target);
    }
    if (
      !denials.some(
        (denial) =>
          denial.kind === kind &&
          "path" in denial &&
          denial.path.toLowerCase() === target.toLowerCase()
      )
    )
      denials.push({ kind, path: target });
  }
  return denials;
}

let verdict: boolean | undefined;
export function probe(): boolean {
  if (verdict === true) return true;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-sandy-probe-"));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const target = path.join(root, "canary.txt");
  let launch: SandyLaunch | undefined;
  try {
    launch = prepare(
      {
        mode: "workspace-write",
        enforcement: "strict",
        workspaceRoot: cwd,
        writableTemp: [],
        toolHomes: [],
        approvedWrites: [],
        secrets: { denied: [], allowed: [], promptable: [] },
        network: { kind: "open" },
      },
      `echo control | cat > allowed.txt && if echo outside > '${target.replaceAll("\\", "/").replaceAll("'", "'\\''")}'; then exit 1; fi`,
      cwd
    );
    const result = spawnSync(launch.argv[0]!, launch.argv.slice(1), {
      cwd,
      env: launch.env,
      timeout: 15000,
      windowsHide: true,
      stdio: "ignore",
    });
    verdict =
      result.status === 0 &&
      fs.existsSync(path.join(cwd, "allowed.txt")) &&
      !fs.existsSync(target);
  } catch {
    verdict = false;
  } finally {
    launch?.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  }
  return verdict;
}
