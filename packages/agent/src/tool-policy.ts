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
    "signin_approval",
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

/**
 * What an unattended run (a routine nobody is watching) was declared to
 * reach when it was created: the hosts `web_fetch` may read, and the one page
 * `browser_task` may open. Fixed for the run; nothing the model reads widens it.
 */
export interface UnattendedPolicy {
  /** Hostnames `web_fetch` may reach, matched exactly: no suffix or wildcard. */
  sourceHosts: readonly string[];
  /** The page a watch routine reads, or null when it reads none. */
  watchUrl: string | null;
  /** What the routine asks about that page; the browser run is built from it. */
  watchPrompt?: string;
}

/** How an allowed tool is checked in an unattended run. */
export type UnattendedRule =
  /** Local, and reads or tracks nothing outside the run. */
  | "allow"
  /** A read, inside the workspace only. */
  | "workspace-read"
  /** A URL, whose host must be one of the declared source hosts. */
  | "source-hosts"
  /** The browser, on the declared watch page only. */
  | "watch-url";

/**
 * The tools an unattended run may call, by the bare name the model sees.
 * Anything not named here is refused as a tool error, so a tool added to the
 * app reaches an unattended run only by a deliberate edit. The desktop's tests
 * check every built-in tool is named here or in UNATTENDED_EXCLUDED_TOOLS.
 */
export const UNATTENDED_TOOLS: Readonly<Record<string, UnattendedRule>> = {
  current_time: "allow",
  todo: "allow",
  skills_list: "allow",
  skill_view: "allow",
  // The query reaches the search provider only, never a host the model picks.
  web_search: "allow",
  x_search: "allow",
  // A spilled tool result, read back: the bytes are already in the run.
  read_output: "allow",
  read: "workspace-read",
  batch_file_read: "workspace-read",
  grep: "workspace-read",
  find: "workspace-read",
  glob: "workspace-read",
  ls: "workspace-read",
  code_map: "workspace-read",
  web_fetch: "source-hosts",
  browser_task: "watch-url",
};

const NO_CODE = "runs code or changes the disk";
const NO_SUBAGENT = "a sub-agent that runs without the gate";
const NO_MEDIA = "media is not part of an unattended run's answer";
const NO_MESSAGES = "messages other people, or reads their messages";
const NO_VAULT = "the vault and payments are never used unattended";
const NO_DEVICES = "drives a device";
const NO_OUTPUT = "a run's only output is its answer to its owner";

/** The built-in tools an unattended run never gets, each with why. */
export const UNATTENDED_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  bash: NO_CODE,
  write: NO_CODE,
  edit: NO_CODE,
  batch_edit: NO_CODE,
  ast_edit: NO_CODE,
  notebook_edit: NO_CODE,
  delete: NO_CODE,
  run_tests: NO_CODE,
  pdf: NO_CODE,
  deck_export_pdf: NO_CODE,
  fetch_background_output: "no background process exists without the shell",
  kill_process: "no background process exists without the shell",
  skill_add: "fetches and writes instructions the agent then follows",
  skill_manage: "writes instructions the agent then follows",
  cronjob: "no new routines from fetched text",
  memory:
    "recall only: memory is in the prompt, and fetched text never reaches it",
  session_search: "past conversations are not this run's input",
  my_activity: "past conversations are not this run's input",
  exit_plan_mode: "never in plan mode",
  delegate_task: NO_SUBAGENT,
  document: NO_SUBAGENT,
  ppt: NO_SUBAGENT,
  design: NO_SUBAGENT,
  serve: "puts a directory on a port, an outbound channel",
  present_deliverable: NO_OUTPUT,
  connect_connector: "changes the account's connections",
  disconnect_connector: "changes the account's connections",
  image_generate: NO_MEDIA,
  text_to_speech: NO_MEDIA,
  vision_analyze: NO_MEDIA,
  video_analyze: NO_MEDIA,
  video_generate: NO_MEDIA,
  xai_video_edit: NO_MEDIA,
  xai_video_extend: NO_MEDIA,
  bfl_flux3_text_to_video: NO_MEDIA,
  bfl_flux3_image_to_video: NO_MEDIA,
  bfl_flux3_keyframes_to_video: NO_MEDIA,
  bfl_flux3_video_continuation: NO_MEDIA,
  bfl_flux3_get_result: NO_MEDIA,
  bfl_flux3_prompting_guide: NO_MEDIA,
  send_chat_message: NO_MESSAGES,
  list_chats: NO_MESSAGES,
  read_chat_messages: NO_MESSAGES,
  auto_reply: NO_MESSAGES,
  send_whatsapp_message: NO_MESSAGES,
  list_whatsapp_chats: NO_MESSAGES,
  read_whatsapp_messages: NO_MESSAGES,
  whatsapp_auto_reply: NO_MESSAGES,
  send_telegram_message: NO_MESSAGES,
  list_telegram_chats: NO_MESSAGES,
  read_telegram_messages: NO_MESSAGES,
  telegram_auto_reply: NO_MESSAGES,
  send_discord_message: NO_MESSAGES,
  list_discord_chats: NO_MESSAGES,
  read_discord_messages: NO_MESSAGES,
  discord_auto_reply: NO_MESSAGES,
  ha_call_service: "physical devices",
  ha_list_entities: "physical devices",
  ha_get_state: "physical devices",
  ha_list_services: "physical devices",
  device_list: NO_DEVICES,
  device_boot: NO_DEVICES,
  device_shutdown: NO_DEVICES,
  device_build: NO_DEVICES,
  device_app: NO_DEVICES,
  device_screenshot: NO_DEVICES,
  device_snapshot: NO_DEVICES,
  device_interact: NO_DEVICES,
  device_logs: NO_DEVICES,
  vault_items: NO_VAULT,
  vault_request: NO_VAULT,
  payment_approval: NO_VAULT,
  signin_approval: NO_VAULT,
  browser_vault_fill: NO_VAULT,
  browser_traveler_fill: NO_VAULT,
  browser_checkout: NO_VAULT,
  browser_pause: "waits for a person, and nobody is there",
  browser_interact: "types, clicks and submits",
  browser_execute: "runs code in the page, an outbound channel",
  browser_tabs: "the watch run reads one page",
  // Driven by the watch run's sub-agent, which the browser holds to the one
  // declared page; never the parent's to call.
  browser_navigate: "the watch run's sub-agent only (UNATTENDED_BROWSER_TOOLS)",
  browser_snapshot: "the watch run's sub-agent only (UNATTENDED_BROWSER_TOOLS)",
};

/**
 * The browser tools a watch run's sub-agent gets, and the only ones the
 * browser serves an unattended session: open the declared page, read it.
 */
export const UNATTENDED_BROWSER_TOOLS: readonly string[] = [
  "browser_navigate",
  "browser_snapshot",
];

/**
 * First-party connector reads an unattended run may make, by the gateway
 * tool's own name and its `action`. Every other connector call, and every
 * tool from a server the user added, is refused.
 */
export const UNATTENDED_CONNECTOR_READS: Readonly<
  Record<string, readonly string[]>
> = {
  Gmail_Tool: ["search_email", "search_email_verbose", "get_my_info"],
  Google_Calendar_Tool: [
    "get_default_timezone",
    "get_calendars",
    "get_free_busy",
    "get_event",
    "search_event",
  ],
};

/** Where a tool the model can call comes from, for the unattended gate. */
export type ToolOrigin =
  /** Registered by the agent itself, or served by the app's built-in servers. */
  | "builtin"
  /** The account's first-party connectors. */
  | "connector"
  /** A server the user added. */
  | "user";

/** A hostname as compared: lowercase, without a trailing dot or brackets. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** Whether `host` is exactly one of `allowed`: no suffix, wildcard or subdomain match. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const wanted = normalizeHost(host);
  return (
    wanted.length > 0 &&
    allowed.some((entry) => normalizeHost(entry) === wanted)
  );
}

/** A policy from its wire form, or null when it is not one. */
export function parseUnattendedPolicy(raw: unknown): UnattendedPolicy | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (value == null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const hosts = Array.isArray(record.sourceHosts)
    ? record.sourceHosts.filter(
        (host): host is string => typeof host === "string" && host.length > 0
      )
    : [];
  const watchUrl =
    typeof record.watchUrl === "string" && record.watchUrl.length > 0
      ? record.watchUrl
      : null;
  return {
    sourceHosts: hosts.map(normalizeHost),
    watchUrl,
    ...(typeof record.watchPrompt === "string"
      ? { watchPrompt: record.watchPrompt }
      : {}),
  };
}
