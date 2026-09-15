/**
 * Selecting a confinement backend, and deciding what to do without one.
 * A backend that works confines; a backend that fails refuses, because a
 * sandbox that silently degrades to unconfined is worse than none; no backend
 * at all (an older Windows) depends on enforcement: `auto` runs and says so,
 * `strict` refuses.
 */
import * as os from "node:os";

import { sandboxBackendFor, type SandboxBackend } from "../sandbox-support.js";
import * as bubblewrap from "./bubblewrap.js";
import * as mxc from "./mxc.js";
import type { SandboxPolicy } from "./policy.js";
import * as seatbelt from "./seatbelt.js";

export type {
  SandboxMode,
  SandboxPolicy,
  SandboxEnforcement,
} from "./policy.js";
export {
  modeToSandboxMode,
  resolvePolicy,
  sandboxEnforcement,
} from "./policy.js";
export { CredentialApprovals } from "./approvals.js";
export {
  EgressProxy,
  egressProxy,
  proxyEnvironment,
  resetEgressProxy,
  type HostDecider,
} from "./egress.js";
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

/**
 * What the model is told when the backend is there but would not start. One
 * retry is allowed (a timed-out probe is not cached, so a loaded machine gets
 * another chance); routing around the sandbox is not.
 */
export function unavailableBackendMessage(backend: SandboxBackend): string {
  const hint =
    backend === "bubblewrap"
      ? ` (Install bubblewrap, or check that unprivileged user namespaces are enabled.)`
      : backend === "mxc"
        ? ` (The Windows process container runner shipped with the app could not start; reinstalling the app restores it.)`
        : "";

  return (
    `Command refused: this machine has a ${backend} sandbox but it could not be ` +
    `established, so the command cannot be confined. This is not a problem with ` +
    `the command. Tell the user. A machine that was merely busy may answer ` +
    `differently next time, so one retry is reasonable; if it keeps happening ` +
    `the sandbox needs fixing, and must not be worked around.` +
    hint
  );
}

/**
 * Whether outbound connections can be forced through the egress proxy here.
 * Seatbelt needs nothing extra; bubblewrap needs socat to bridge into its
 * network namespace; the Windows container is not wired to the proxy yet.
 */
export function networkConfinable(): boolean {
  switch (backendName()) {
    case "seatbelt":
      return true;
    case "bubblewrap":
      return bubblewrap.socatPath() !== null;
    default:
      return false;
  }
}

export function decide(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  /** The environment the command will be spawned with, when not this process's. */
  childEnv: NodeJS.ProcessEnv = process.env
): SandboxDecision {
  if (policy.enforcement === "off" || policy.mode === "danger-full-access") {
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

  if (backend === "seatbelt") {
    // A policy the profile language cannot express is a readable refusal, not
    // an exception.
    const refusal = seatbelt.policyRefusal(policy);
    if (refusal !== null) return { kind: "refused", message: refusal };
  }

  const argv =
    backend === "seatbelt"
      ? seatbelt.wrap(policy, command)
      : backend === "bubblewrap"
        ? bubblewrap.wrap(policy, command, cwd, childEnv.PATH)
        : mxc.wrap(policy, command, cwd, childEnv);

  if (argv === null) {
    // Backend present but would not start: never fall through to running.
    return { kind: "refused", message: unavailableBackendMessage(backend) };
  }

  return { kind: "confined", argv, backend };
}
