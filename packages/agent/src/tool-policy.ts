/**
 * Which of the app's MCP tools a forever chat gets, for a profile that opts
 * in (the phone). Under a policy a built-in tool reaches the chat only when
 * named, so a tool added to the app reaches the phone only by a deliberate
 * edit here. The connectors' tools (Gmail, Drive, and servers the user
 * added) are one switch. A profile without a policy gets every tool, as
 * before. The browser's own tools never reach the chat itself; its
 * `browser_task` sub-agent drives them.
 *
 * A leaf module: the desktop's tests read it (`@abacus-ai/agent/tool-policy`)
 * and check that every built-in tool the app serves is named either here or
 * in `PHONE_EXCLUDED_MCP_TOOLS`, so a new one is a decision, not a default.
 * `browser_*` tools are the sub-agent's and need neither.
 */

export interface McpToolPolicy {
  /** Built-in servers' tools (agent-tools, device), by the bare name the model sees. */
  builtin: readonly string[];
  /** The account's connectors and servers the user added. */
  connectors: boolean;
}

/** Whether a chat under `policy` gets this MCP tool; any tool without one. */
export function mcpToolAllowed(
  policy: McpToolPolicy | undefined,
  tool: { name: string; builtin: boolean }
): boolean {
  if (policy == null) return true;
  return tool.builtin ? policy.builtin.includes(tool.name) : policy.connectors;
}

/**
 * The WhatsApp number's chat: every built-in tool that works without a
 * screen. Left out: `memory` (the phone keeps its own) and the `device_*`
 * tools, which drive simulators and devices mirrored into an app pane.
 * `serve` and `present_deliverable` word themselves for the phone (see the
 * desktop's tools/deliverables.ts).
 */
export const PHONE_MCP_TOOLS: McpToolPolicy = {
  builtin: [
    "skills_list",
    "skill_view",
    "skill_manage",
    "todo",
    "cronjob",
    "vision_analyze",
    "video_analyze",
    "image_generate",
    "text_to_speech",
    "video_generate",
    "xai_video_edit",
    "xai_video_extend",
    "bfl_flux3_text_to_video",
    "bfl_flux3_image_to_video",
    "bfl_flux3_keyframes_to_video",
    "bfl_flux3_video_continuation",
    "bfl_flux3_get_result",
    "bfl_flux3_prompting_guide",
    "x_search",
    "ha_list_entities",
    "ha_get_state",
    "ha_list_services",
    "ha_call_service",
    "pdf",
    "deck_export_pdf",
    "serve",
    "present_deliverable",
    "connect_connector",
    "disconnect_connector",
    "my_activity",
    "list_whatsapp_chats",
    "send_whatsapp_message",
    "read_whatsapp_messages",
    "list_telegram_chats",
    "send_telegram_message",
    "read_telegram_messages",
    "list_discord_chats",
    "send_discord_message",
    "read_discord_messages",
    // The vault, from the browser server: saved logins and approved cards.
    "vault_items",
    "vault_request",
    "payment_approval",
  ],
  connectors: true,
};

/** The built-in tools the phone does not get, each with why. */
export const PHONE_EXCLUDED_MCP_TOOLS: Readonly<Record<string, string>> = {
  memory: "the phone keeps its own memory tool",
  send_chat_message: "hidden: the per-platform tools delegate to it",
  list_chats: "hidden: the per-platform tools delegate to it",
  read_chat_messages: "hidden: the per-platform tools delegate to it",
  auto_reply: "hidden: the per-platform tools delegate to it",
  whatsapp_auto_reply: "a bot's alone",
  telegram_auto_reply: "a bot's alone",
  discord_auto_reply: "a bot's alone",
  device_list: "drives a simulator mirrored into an app pane",
  device_boot: "drives a simulator mirrored into an app pane",
  device_shutdown: "drives a simulator mirrored into an app pane",
  device_build: "drives a simulator mirrored into an app pane",
  device_app: "drives a simulator mirrored into an app pane",
  device_screenshot: "drives a simulator mirrored into an app pane",
  device_snapshot: "drives a simulator mirrored into an app pane",
  device_interact: "drives a simulator mirrored into an app pane",
  device_logs: "drives a simulator mirrored into an app pane",
};
