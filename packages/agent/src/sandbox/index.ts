/**
 * Selecting a confinement backend, and deciding what to do without one.
 * A backend that works confines; a backend that fails refuses, because a
 * sandbox that silently degrades to unconfined is worse than none; no backend
 * at all (Windows) depends on enforcement: `auto` runs and says so, `strict`
 * refuses.
 */
import * as bubblewrap from "./bubblewrap.js";
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
export { readableExemptions, resolveSecretPaths } from "./secrets.js";

export type SandboxDecision =
  /** Run this argv instead of the bare command. */
  | { kind: "confined"; argv: string[]; backend: "seatbelt" | "bubblewrap" }
  /** No confinement needed — the mode asked for none. */
  | { kind: "unconfined"; reason: "mode" }
  /** No backend on this platform, and enforcement permits running anyway. */
  | { kind: "unconfined"; reason: "unsupported-platform" }
  /** Do not run. `message` is written where the model will read it. */
  | { kind: "refused"; message: string };

/** Whether this platform has a confinement backend at all, working or not. */
export function backendName(): "seatbelt" | "bubblewrap" | null {
  if (process.platform === "darwin") return "seatbelt";
  if (process.platform === "linux") return "bubblewrap";

  return null;
}

/**
 * What the model is told when the backend is there but would not start. One
 * retry is allowed (a timed-out probe is not cached, so a loaded machine gets
 * another chance); routing around the sandbox is not.
 */
export function unavailableBackendMessage(
  backend: "seatbelt" | "bubblewrap"
): string {
  return (
    `Command refused: this machine has a ${backend} sandbox but it could not be ` +
    `established, so the command cannot be confined. This is not a problem with ` +
    `the command. Tell the user. A machine that was merely busy may answer ` +
    `differently next time, so one retry is reasonable; if it keeps happening ` +
    `the sandbox needs fixing, and must not be worked around.` +
    (backend === "bubblewrap"
      ? ` (Install bubblewrap, or check that unprivileged user namespaces are enabled.)`
      : "")
  );
}

export function decide(
  policy: SandboxPolicy,
  command: string,
  cwd: string,
  /** The PATH the command will be spawned with, when it is not this process's. */
  childPath?: string
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
      : bubblewrap.wrap(policy, command, cwd, childPath);

  if (argv === null) {
    // Backend present but would not start: never fall through to running.
    return { kind: "refused", message: unavailableBackendMessage(backend) };
  }

  return { kind: "confined", argv, backend };
}
