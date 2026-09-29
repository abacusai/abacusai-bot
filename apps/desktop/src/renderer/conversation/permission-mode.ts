import type { PermissionMode } from "./agent-types";
import type { ConversationPermissionMode } from "./types";

/**
 * Widen a `PermissionMode` enum value to the conversation store's string
 * dialect (`ConversationPermissionMode = `${PermissionMode}``). Every mode
 * (including plan mode, which the server loop drives via the per-turn
 * `agentMode` field) is valid on the live path.
 */
export function toConversationPermissionMode(
  mode: PermissionMode
): ConversationPermissionMode {
  return mode;
}
