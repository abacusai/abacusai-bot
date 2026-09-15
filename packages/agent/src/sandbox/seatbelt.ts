/**
 * macOS confinement via Seatbelt (`sandbox-exec`). The profile is
 * allow-by-default with a blanket `(deny file-write*)` and an allowlist on top:
 * deny-by-default breaks compilers in ways that look like broken machines, and
 * the property bought is only "cannot write outside the workspace". The CLI is
 * deprecated but shipped; the probe is what makes relying on it safe.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { SandboxPolicy } from "./policy.js";
import { shellArgs } from "./shell.js";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** C0 controls and DEL — legal in a filename, not in a profile string. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }

  return false;
}

/**
 * Quote a path into a Scheme string literal. The profile is a program, and a
 * raw quote or backslash in a directory name would change what the rest of a
 * security policy means.
 */
function schemeString(value: string): string {
  // A raw control character (legal in an APFS filename) fails compilation
  // with an unreadable error; refuse it with one that names the problem.
  if (hasControlCharacter(value)) {
    throw new Error(
      `Cannot sandbox a path containing control characters: ${JSON.stringify(value)}. ` +
        `Rename the directory to something without them.`
    );
  }

  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildProfile(policy: SandboxPolicy): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    // A process needs its tty, /dev/null and its pty. Seatbelt checks the
    // resolved vnode type, so /dev/fd/N pointing at a regular file is refused.
    "(allow file-write-data (require-all (vnode-type CHARACTER-DEVICE)))",
    // Close the launchd hole: a process launchd starts on our behalf (`open`)
    // is not a child and inherits no sandbox, so an app bundle written into
    // the workspace would run unconfined. Both halves are needed: the service
    // denial stops a binary the exec rule cannot name, the exec denial holds
    // when the service names move. Prefixes, not names, because the launch
    // path changes between macOS releases.
    "(deny mach-lookup",
    '  (global-name-prefix "com.apple.coreservices.")',
    '  (global-name-prefix "com.apple.CoreServices.")',
    '  (global-name-prefix "com.apple.lsd.")',
    '  (global-name "com.apple.system.opendirectoryd.api"))',
    "(deny process-exec*",
    '  (literal "/usr/bin/open")',
    '  (literal "/usr/bin/osascript")',
    '  (literal "/bin/launchctl")',
    '  (literal "/usr/bin/launchctl"))',
    // A task port lets a confined process write an unconfined one's memory.
    "(deny mach-priv-task-port)",
  ];

  if (policy.mode === "workspace-write") {
    lines.push(
      `(allow file-write* (subpath ${schemeString(policy.workspaceRoot)}))`
    );
  }

  // Temp is writable in read-only mode too, or python, compilers, mktemp and
  // git's temp index all fail on their first scratch file; matches bubblewrap.
  if (policy.mode === "workspace-write" || policy.mode === "read-only") {
    for (const temp of policy.writableTemp) {
      lines.push(`(allow file-write* (subpath ${schemeString(temp)}))`);
    }
  }

  // Credential stores. A later rule wins in Seatbelt, so the files read back
  // must follow the denials.
  for (const denied of policy.secrets.denied) {
    lines.push(`(deny file-read* (subpath ${schemeString(denied)}))`);
  }
  for (const allowed of policy.secrets.allowed) {
    lines.push(`(allow file-read* (subpath ${schemeString(allowed)}))`);
  }

  return lines.join("\n");
}

/**
 * Why this policy cannot become a profile, or null when it can. Asked up
 * front so the model reads a sentence naming the directory instead of every
 * command failing for reasons it cannot interpret.
 */
export function policyRefusal(policy: SandboxPolicy): string | null {
  // Exactly the paths buildProfile interpolates, in the modes it does.
  const interpolated = [
    ...(policy.mode === "workspace-write" ? [policy.workspaceRoot] : []),
    ...(policy.mode === "workspace-write" || policy.mode === "read-only"
      ? policy.writableTemp
      : []),
    ...policy.secrets.denied,
    ...policy.secrets.allowed,
  ];

  for (const value of interpolated) {
    if (hasControlCharacter(value)) {
      return (
        `Command refused: the sandbox cannot describe a path containing control ` +
        `characters, and this one does: ${JSON.stringify(value)}. Ask the user to ` +
        `rename the directory to something without them. Do not retry.`
      );
    }
  }

  return null;
}

/** Argv that runs `command` under the profile, or null when unavailable. */
export function wrap(policy: SandboxPolicy, command: string): string[] | null {
  if (!probe()) return null;

  return [
    SANDBOX_EXEC,
    "-p",
    buildProfile(policy),
    "--",
    "/bin/bash",
    ...shellArgs(command),
  ];
}

let probed: boolean | undefined;

/**
 * Confirm the runner actually confines, not merely exists: a write outside
 * the allowlist must be refused.
 */
export function probe(): boolean {
  if (probed !== undefined) return probed;

  // A private target: a fixed path in /tmp could be pre-created by another
  // account, making the write fail for reasons unrelated to the sandbox.
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-probe-"));
  } catch {
    probed = false;

    return probed;
  }

  const target = path.join(dir, "canary");

  try {
    const profile = [
      "(version 1)",
      "(allow default)",
      "(deny file-write*)",
    ].join("\n");
    execFileSync(
      SANDBOX_EXEC,
      [
        "-p",
        profile,
        "--",
        "/bin/bash",
        "-c",
        `touch ${JSON.stringify(target)} 2>/dev/null`,
      ],
      { stdio: "ignore", timeout: 10_000 }
    );
    // Exit 0 means the write was permitted: the profile is not being enforced.
    probed = false;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number | null };
    // Only a genuine non-zero exit counts. A missing binary, timeout or
    // signal means UNKNOWN, and unknown has to mean unavailable.
    probed = typeof failure.status === "number" && failure.status !== 0;
  }

  // Whatever the exit code claimed, the file existing means the write went
  // through.
  if (probed) {
    try {
      if (fs.existsSync(target)) probed = false;
    } catch {
      probed = false;
    }
  }

  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leftover empty temp directory is not worth failing over.
  }

  return probed;
}
