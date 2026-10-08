/**
 * The session's current permission mode, visible to extensions, which have no
 * handle on the session but must not run project code in ask-first modes. One
 * host process owns exactly one session, so a module singleton is accurate.
 */
import { AgentMode } from "./protocol.js";
import type { UnattendedPolicy } from "./tool-policy.js";

let mode: AgentMode = AgentMode.Normal;

export function setCurrentMode(next: AgentMode): void {
  mode = next;
}

export function currentMode(): AgentMode {
  return mode;
}

/**
 * An unattended run's declared reach, set once at spawn with the mode. Null
 * for every other session; `web_fetch` reads it on every call.
 */
let unattended: UnattendedPolicy | null = null;

export function setUnattendedPolicy(next: UnattendedPolicy | null): void {
  unattended = next;
}

/**
 * The hosts `web_fetch` is held to, or null when it is not held: only an
 * unattended session is, and one that lost its policy reaches nothing.
 */
export function fetchHostAllowlist(): readonly string[] | null {
  if (mode !== AgentMode.Unattended) return null;
  return unattended?.sourceHosts ?? [];
}

export function unattendedPolicy(): UnattendedPolicy | null {
  return mode === AgentMode.Unattended ? unattended : null;
}
