/**
 * Selecting a confinement backend, and deciding what to do without one.
 * A backend that works confines. Without one, or with one that cannot start
 * (no bubblewrap or socat, an older Windows), `auto` runs the command
 * unconfined and the session says so on screen; `strict` refuses instead.
 */
import * as os from "node:os";

import { sandboxBackendFor, type SandboxBackend } from "../sandbox-support.js";
import * as mxc from "./mxc.js";
import { sandboxEnforcement, type SandboxPolicy } from "./policy.js";
import * as runtime from "./runtime.js";

export type {
  NetworkPolicy,
  SandboxMode,
  SandboxPolicy,
  SandboxEnforcement,
} from "./policy.js";
export {
  modeToSandboxMode,
  resolvePolicy,
  sandboxEnforcement,
} from "./policy.js";
export {
  SandboxApprovals,
  type Denial,
  type DenialAsker,
  type DenialDecision,
} from "./approvals.js";
export {
  allowHostForSession,
  allowHostOnce,
  DEFAULT_HOSTS,
  denials,
  ensureRuntime,
  setHostDecider,
  violations,
  type HostDecider,
} from "./runtime.js";
export {
  mentionedSecretPaths,
  namedSecretPaths,
  readableExemptions,
  resolveSecretPaths,
  type SecretPaths,
} from "./secrets.js";
export type { SandboxBackend } from "../sandbox-support.js";

export type SandboxDecision =
  /** Run this argv instead of the bare command. */
  | { kind: "confined"; argv: string[]; backend: SandboxBackend }
  /** No confinement needed — the mode asked for none. */
  | { kind: "unconfined"; reason: "mode" }
  /** No backend on this platform, and enforcement permits running anyway. */
  | { kind: "unconfined"; reason: "unsupported-platform" }
  /** A backend exists but could not start, and enforcement permits running. */
  | { kind: "unconfined"; reason: "backend-unavailable" }
  /** Do not run. `message` is written where the model will read it. */
  | { kind: "refused"; message: string };

/**
 * Whether this platform has a confinement backend at all, working or not.
 * Windows counts only from the build that can make a process container; an
 * older one has no backend rather than a broken one.
 */
export function backendName(): SandboxBackend | null {
  return sandboxBackendFor(process.platform, os.release());
}

/** Whether the backend forces outbound connections through the asking proxy. */
export function networkConfinable(): boolean {
  return backendName() === "sandbox-runtime";
}

/**
 * What the model is told when the backend is there but would not start. One
 * retry is allowed (a timed-out probe is not cached, so a loaded machine gets
 * another chance); routing around the sandbox is not.
 */
export function unavailableBackendMessage(
  backend: SandboxBackend,
  detail: string | null = null
): string {
  const hint =
    backend === "sandbox-runtime" && process.platform === "linux"
      ? ` (Install bubblewrap and socat, and check that unprivileged user namespaces are enabled.)`
      : backend === "mxc"
        ? ` (The Windows process container runner shipped with the app could not start; reinstalling the app restores it.)`
        : "";

  return (
    `Command refused: this machine has a ${backend} sandbox but it could not be ` +
    `established, so the command cannot be confined. This is not a problem with ` +
    `the command. Tell the user. A machine that was merely busy may answer ` +
    `differently next time, so one retry is reasonable; if it keeps happening ` +
    `the sandbox needs fixing, and must not be worked around.` +
    hint +
    (detail != null ? ` Reported: ${detail}` : "")
  );
}

export async function decide(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  /** The environment the command will be spawned with, when not this process's. */
  childEnv: NodeJS.ProcessEnv = process.env,
  /** Correlates the runtime's violation records with this run. */
  commandId: string = `command-${Date.now()}-${Math.random().toString(16).slice(2)}`
): Promise<SandboxDecision> {
  if (policy.enforcement === "off") {
    return { kind: "unconfined", reason: "mode" };
  }

  const backend = backendName();

  if (backend === null) {
    if (policy.enforcement === "strict") {
      return {
        kind: "refused",
        message:
          `Command refused: ABACUSAI_BOT_SANDBOX=strict requires a sandbox, and ` +
          `there is no sandbox backend for ${process.platform}. Set ` +
          `ABACUSAI_BOT_SANDBOX=auto to run commands unconfined on this platform.`,
      };
    }

    return { kind: "unconfined", reason: "unsupported-platform" };
  }

  const argv =
    backend === "sandbox-runtime"
      ? await runtime.wrap(policy, command, cwd, commandId)
      : mxc.wrap(policy, command, cwd, childEnv);

  if (argv === null) {
    if (policy.enforcement === "strict") {
      return {
        kind: "refused",
        message: unavailableBackendMessage(
          backend,
          backend === "sandbox-runtime" ? runtime.runtimeFailure() : null
        ),
      };
    }

    return { kind: "unconfined", reason: "backend-unavailable" };
  }

  return { kind: "confined", argv, backend };
}

/** Whether shell commands will actually be confined here, and why not. */
export interface SandboxAvailability {
  active: boolean;
  reason: string | null;
}

/**
 * Asked once per session so the screen can say when nothing confines. The
 * probe runs here rather than on the first command, so the answer is known
 * before the user asks for anything.
 */
export async function sandboxAvailability(): Promise<SandboxAvailability> {
  if (sandboxEnforcement() === "off")
    return { active: false, reason: "switched off" };

  const backend = backendName();
  if (backend === null)
    return {
      active: false,
      reason:
        process.platform === "win32"
          ? "needs Windows 11 24H2 or newer"
          : `no sandbox backend for ${process.platform}`,
    };

  if (backend === "mxc") {
    return mxc.probe()
      ? { active: true, reason: null }
      : { active: false, reason: "the Windows sandbox runner could not start" };
  }

  if (!(await runtime.ensureRuntime()))
    return {
      active: false,
      reason:
        runtime.runtimeFailure() ??
        (process.platform === "linux"
          ? "bubblewrap or socat is not installed"
          : "the sandbox runtime could not start"),
    };
  if (!(await runtime.probe()))
    return {
      active: false,
      reason:
        process.platform === "linux"
          ? "bubblewrap cannot create a namespace here"
          : "the sandbox did not hold in a probe",
    };

  return { active: true, reason: null };
}
