/**
 * Selecting a confinement backend, and deciding what to do without one.
 * A backend that works confines. Without one, or with one that cannot start
 * (no bubblewrap or socat, an older Windows), `auto` can run unconfined
 * with a warning. A broken Sandy installation always refuses execution.
 */
import * as os from "node:os";

import { sandboxBackendFor, type SandboxBackend } from "../sandbox-support.js";
import type { Denial } from "./approvals.js";
import { sandboxEnforcement, type SandboxPolicy } from "./policy.js";
import * as runtime from "./runtime.js";
import * as sandy from "./sandy.js";

export type {
  NetworkPolicy,
  SandboxMode,
  SandboxPolicy,
  SandboxEnforcement,
} from "./policy.js";
export {
  canonicalize,
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
  settledDenials,
  shutdownRuntime,
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
  | {
      kind: "confined";
      argv: string[];
      backend: SandboxBackend;
      env?: NodeJS.ProcessEnv;
      cleanup?: () => void;
      denials?: (stderr: string) => Denial[];
    }
  /** No confinement wanted: Full access, or switched off by the environment. */
  | { kind: "unconfined"; reason: "mode" }
  /** No backend on this platform, and enforcement permits running anyway. */
  | { kind: "unconfined"; reason: "unsupported-platform" }
  /** A backend exists but could not start, and enforcement permits running. */
  | { kind: "unconfined"; reason: "backend-unavailable" }
  /** Do not run. `message` is written where the model will read it. */
  | { kind: "refused"; message: string };

/**
 * Whether this platform has a confinement backend at all, working or not.
 * Windows requires AppContainer and support for the bundled BusyBox binary.
 */
export function backendName(): SandboxBackend | null {
  return sandboxBackendFor(process.platform, os.release());
}

/**
 * Route supported platforms through the confinement decision, including
 * installations whose runner is missing or broken.
 */
export function backendPresent(): boolean {
  const backend = backendName();
  if (backend === null) return false;

  // Keep Auto commands on the decision path even if Sandy's payload is lost:
  // a missing runner must produce a refusal, not an unconfined fallback.
  return true;
}

/** Whether the backend forces outbound connections through the asking proxy. */
export function networkConfinable(): boolean {
  return backendName() === "sandbox-runtime";
}

/**
 * What the model is told when the backend is there but would not start. One
 * retry is allowed (the runtime may have been starting); routing around the
 * sandbox is not.
 */
export function unavailableBackendMessage(
  backend: SandboxBackend,
  detail: string | null = null
): string {
  const hint =
    backend === "sandbox-runtime" && process.platform === "linux"
      ? ` (Install bubblewrap and socat, and check that unprivileged user namespaces are enabled.)`
      : backend === "sandy"
        ? ` (The Sandy runner shipped with the app could not start or apply its file grants.)`
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

  if (backend === "sandy") {
    try {
      if (!sandy.probe())
        throw new Error("The Windows sandbox confinement probe failed.");
      return {
        kind: "confined",
        backend,
        ...sandy.prepare(policy, command, cwd, childEnv),
      };
    } catch (error) {
      return {
        kind: "refused",
        message: unavailableBackendMessage(
          backend,
          error instanceof Error ? error.message : String(error)
        ),
      };
    }
  }
  const argv = await runtime.wrap(policy, command, cwd, commandId);

  if (argv === null) {
    if (policy.enforcement === "strict") {
      return {
        kind: "refused",
        message: unavailableBackendMessage(backend, runtime.runtimeFailure()),
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
 * Whether a confined mode would actually confine here. The desktop asks
 * once (`--sandbox-probe`) to decide whether to offer Auto at all: a machine
 * that cannot sandbox gets Full access alone, plainly, rather than an Auto
 * that quietly runs everything unconfined.
 */
export async function sandboxAvailability(): Promise<SandboxAvailability> {
  if (sandboxEnforcement() === "off")
    return { active: false, reason: "switched off by ABACUSAI_BOT_SANDBOX" };

  const backend = backendName();
  if (backend === null)
    return {
      active: false,
      reason:
        process.platform === "win32"
          ? "needs Windows 10 1903 or newer (Windows 11 on ARM64)"
          : `no sandbox backend for ${process.platform}`,
    };

  if (backend === "sandy") {
    return sandy.probe()
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
