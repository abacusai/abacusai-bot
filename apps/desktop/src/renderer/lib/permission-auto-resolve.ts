import { AgentMode } from "#shared/agent-types";

import type { PermissionRequest } from "../conversation/agent-types";

/**
 * Whether the mode the user picked answers a queued prompt on its own.
 * `set_mode` only governs what the agent has yet to ask, so the prompt that
 * made the user switch would otherwise stay up: Full access settles it as
 * "allow", Auto lets it through once (the agent asks nothing more in Auto,
 * and "allowYolo" would drop the sandbox too), Auto-Accept settles an edit.
 *
 * Never a sandbox card. Auto skips the tool approvals, not the sandbox, so a
 * hidden credential store, a host off the allow list, or something the OS
 * refused is still the user's to answer, in every mode.
 */
export function autoResolution(
  request: PermissionRequest,
  mode: AgentMode
): "allowYolo" | "accept" | null {
  if (isSandboxCard(request)) return null;

  if (mode === AgentMode.Yolo) return "allowYolo";
  if (mode === AgentMode.Auto) return "accept";

  const isEdit =
    request.type === "edit_file" ||
    request.type === "write_file" ||
    request.type === "edit_outside_directory" ||
    request.type === "write_outside_directory";

  return mode === AgentMode.AcceptEdits && isEdit ? "accept" : null;
}

/**
 * The mode a card's answer moves the session to, if any. "Always" on a tool
 * approval is a request to stop asking about edits, "allow all" to stop
 * asking at all. On a sandbox card neither is being said: "always" there
 * keeps those paths or that host for the session, and the mode must stay
 * where it is, or one click on a card would drop Auto to Auto-Accept.
 */
export function modeAfterDecision(
  request: PermissionRequest,
  decision: string
): AgentMode | null {
  if (isSandboxCard(request)) return null;
  if (decision === "allowAlways") return AgentMode.AcceptEdits;
  if (decision === "allowYolo") return AgentMode.Yolo;

  return null;
}

/** The prompts the sandbox raises, as opposed to the tool approvals. */
export function isSandboxCard(request: PermissionRequest): boolean {
  return (
    request.type === "sandbox_denied" ||
    request.type === "network_host" ||
    (request.type === "run_terminal" &&
      (request.credentialPaths?.length ?? 0) > 0)
  );
}
