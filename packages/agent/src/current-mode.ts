/**
 * The session's current permission mode, visible to extensions, which have no
 * handle on the session but must not run project code in ask-first modes. One
 * host process owns exactly one session, so a module singleton is accurate.
 */
import { AgentMode } from "./protocol.js";

let mode: AgentMode = AgentMode.Normal;

export function setCurrentMode(next: AgentMode): void {
  mode = next;
}

export function currentMode(): AgentMode {
  return mode;
}
