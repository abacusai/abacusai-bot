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
import { realPathOf } from "../workspace-path.js";
import {
  readableExemptions,
  resolveSecretPaths,
  type SecretPaths,
} from "./secrets.js";
import { existingToolHomes } from "./zones.js";

/** What the OS is asked to enforce on files. */
export type SandboxMode = "read-only" | "workspace-write";

/** How hard to insist on a sandbox. */
export type SandboxEnforcement =
  /** Never sandbox: Full access, or ABACUSAI_BOT_SANDBOX=off. */
  | "off"
  /** Sandbox where a backend exists, run unconfined where none does. The default. */
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
  /** Caches and toolchains a build writes to as a matter of course (zones.ts). */
  toolHomes: string[];
  /** Credential stores hidden from the command, and what is read back. */
  secrets: SecretPaths;
  /** Paths outside the workspace the user let this command write. */
  approvedWrites: string[];
  /** Additional reads explicitly approved by the user. */
  approvedReads?: string[];
  /** Where the command's outbound connections may go. */
  network: NetworkPolicy;
}

/**
 * Outbound network: open, or only through the runtime's proxies, which hold
 * an unlisted host while the user is asked (runtime.ts).
 */
export type NetworkPolicy = { kind: "open" } | { kind: "filtered" };

/**
 * The mode decides: Full access is the one mode with no sandbox, and every
 * other mode is confined where a backend exists. ABACUSAI_BOT_SANDBOX in the
 * environment overrides for the deliberate: `off` never confines, `strict`
 * refuses a command rather than run it unconfined.
 */
export function sandboxEnforcement(mode?: AgentMode): SandboxEnforcement {
  if (mode === AgentMode.Yolo) return "off";

  const raw = (process.env.ABACUSAI_BOT_SANDBOX ?? "").trim().toLowerCase();

  if (raw === "strict") return "strict";
  if (raw === "off" || raw === "0" || raw === "false") return "off";

  return "auto";
}

/**
 * Plan's gate-level read-only becomes true at the OS level; every other mode
 * gets the workspace. Auto included: it skips the approval prompts, so it is
 * exactly where the kernel bounds matter most. Full access is off entirely
 * (sandboxEnforcement), so what it maps to never applies.
 */
export function modeToSandboxMode(mode: AgentMode): SandboxMode {
  return mode === AgentMode.PlanMode ? "read-only" : "workspace-write";
}

/**
 * Resolve a path to what the kernel will see: on macOS `/tmp` IS
 * `/private/tmp`, and a profile naming the symlink grants nothing. A path
 * that does not exist yet is resolved through its nearest existing ancestor
 * (`/var/folders/…/new.txt` is `/private/var/folders/…/new.txt`), so a file
 * about to be made is judged where it will land.
 */
export function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return realPathOf(target) ?? path.resolve(target);
  }
}

export function resolvePolicy(
  mode: AgentMode,
  cwd: string,
  options: {
    /** Stores the user approved for this command, on top of the environment's. */
    approvedReads?: readonly string[];
    /** Paths the user let this command write, from a card after a refusal. */
    approvedWrites?: readonly string[];
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
    enforcement: sandboxEnforcement(mode),
    workspaceRoot,
    writableTemp: [...temps],
    toolHomes: existingToolHomes(),
    secrets: resolveSecretPaths({
      workspaceRoot,
      exemptions: [...readableExemptions(), ...(options.approvedReads ?? [])],
    }),
    approvedWrites: [...(options.approvedWrites ?? [])],
    approvedReads: [...readableExemptions(), ...(options.approvedReads ?? [])],
    network:
      options.filteredNetwork === true
        ? { kind: "filtered" }
        : { kind: "open" },
  };
}
