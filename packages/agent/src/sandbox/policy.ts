import * as fs from "node:fs";
import * as os from "node:os";
/**
 * What a sandboxed command may touch, and what happens when the sandbox
 * cannot be established. The permission gate and guardrails decide by reading
 * the command, which loses to one they did not anticipate (base64, `$IFS`, a
 * heredoc); the sandbox asks the OS to refuse the writes regardless. The gate
 * stops what should not be attempted; the sandbox bounds what an attempt does.
 */
import * as path from "node:path";

import { AgentMode } from "../protocol.js";
import {
  readableExemptions,
  resolveSecretPaths,
  type SecretPaths,
} from "./secrets.js";

/** What the OS is asked to enforce on files. */
export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

/** How hard to insist on a sandbox. */
export type SandboxEnforcement =
  /** Never sandbox. The default — see sandboxEnforcement. */
  | "off"
  /** Sandbox where a backend exists, run unconfined where none does. */
  | "auto"
  /** Require a working sandbox. No sandbox, no command. */
  | "strict";

export interface SandboxPolicy {
  mode: SandboxMode;
  enforcement: SandboxEnforcement;
  /** The one directory `workspace-write` may write under, fully resolved. */
  workspaceRoot: string;
  /** Temp directories a build is entitled to, fully resolved. */
  writableTemp: string[];
  /** Credential stores hidden from the command, and what is read back. */
  secrets: SecretPaths;
  /** Where the command's outbound connections may go. */
  network: NetworkPolicy;
}

/**
 * Outbound network: open, or only through the runtime's proxies, which hold
 * an unlisted host while the user is asked (runtime.ts).
 */
export type NetworkPolicy = { kind: "open" } | { kind: "filtered" };

/**
 * Off unless something asks for it: the agent does not decide on its own. The
 * desktop sets ABACUSAI_BOT_SANDBOX=auto while its Settings toggle is on,
 * which it is by default, and nothing when the user switched it off. Off
 * means bash is bounded only by the permission gate and guardrails.
 */
export function sandboxEnforcement(): SandboxEnforcement {
  const raw = (process.env.ABACUSAI_BOT_SANDBOX ?? "").trim().toLowerCase();

  if (raw === "strict") return "strict";
  if (raw === "auto" || raw === "1" || raw === "true") return "auto";

  return "off";
}

/**
 * The sandbox follows the permission mode rather than adding a second control
 * that can disagree with it: Plan's gate-level read-only becomes true at the
 * OS level, and Bypass is a deliberate request to run unimpeded.
 */
export function modeToSandboxMode(mode: AgentMode): SandboxMode {
  switch (mode) {
    case AgentMode.PlanMode:
      return "read-only";
    case AgentMode.Yolo:
      return "danger-full-access";
    default:
      return "workspace-write";
  }
}

/**
 * Resolve a path to what the kernel will see: on macOS `/tmp` IS
 * `/private/tmp`, and a profile naming the symlink grants nothing. A path
 * that does not exist yet is normalized lexically so `mkdir && cd` still works.
 */
export function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

export function resolvePolicy(
  mode: AgentMode,
  cwd: string,
  options: {
    /** Stores the user approved for this command, on top of the environment's. */
    approvedReads?: readonly string[];
    /** Whether the backend can force connections through the asking proxy. */
    filteredNetwork?: boolean;
  } = {}
): SandboxPolicy {
  const temps = new Set<string>();
  for (const candidate of ["/tmp", os.tmpdir()]) {
    if (candidate) temps.add(canonicalize(candidate));
  }

  const workspaceRoot = canonicalize(cwd);
  return {
    mode: modeToSandboxMode(mode),
    enforcement: sandboxEnforcement(),
    workspaceRoot,
    writableTemp: [...temps],
    secrets: resolveSecretPaths({
      workspaceRoot,
      exemptions: [...readableExemptions(), ...(options.approvedReads ?? [])],
    }),
    network:
      options.filteredNetwork === true
        ? { kind: "filtered" }
        : { kind: "open" },
  };
}
