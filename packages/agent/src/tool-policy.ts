/**
 * Which of the app's MCP tools a forever chat gets, for a profile that opts
 * in (the phone). Under a policy a built-in tool reaches the chat only when
 * named, so a tool added to the app reaches the phone only by a deliberate
 * edit here. The connectors' tools (Gmail, Drive, and servers the user
 * added) are one switch. A profile without a policy gets every tool, as
 * before. The browser's own tools never reach the chat itself; its
 * `browser_task` sub-agent drives them.
 *
 * A leaf module (node's `net` only): the desktop's tests read it (`@abacus-ai/agent/tool-policy`)
 * and check that every built-in tool the app serves is named either here or
 * in `PHONE_EXCLUDED_MCP_TOOLS`, so a new one is a decision, not a default.
 * `browser_*` tools are the sub-agent's and need neither.
 */
import { isIPv4, isIPv6 } from "node:net";

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
 * The agent-tools tools the WhatsApp chat gets: one per job. The desktop's
 * phone definitions (its tools/phone) are exactly these, checked when that
 * module loads, so a tool reaches the phone only by a definition written in
 * its words.
 */
export const PHONE_AGENT_TOOL_NAMES: readonly string[] = [
  "skills_list",
  "skill_view",
  "cronjob",
  "vision_analyze",
  "video_analyze",
  "x_search",
  "pdf",
  "deck_export_pdf",
  "serve",
  "present_deliverable",
  "connect_connector",
  "disconnect_connector",
  "billing_plan",
];

/** The vault's tools, from the browser server: saved logins, approved cards and sign-ins. */
export const PHONE_VAULT_TOOL_NAMES: readonly string[] = [
  "vault_items",
  "vault_request",
  "payment_approval",
  "signin_approval",
];

/**
 * The WhatsApp number's chat. Left out, each with why, in
 * `PHONE_EXCLUDED_MCP_TOOLS`.
 */
export const PHONE_MCP_TOOLS: McpToolPolicy = {
  builtin: [...PHONE_AGENT_TOOL_NAMES, ...PHONE_VAULT_TOOL_NAMES],
  connectors: true,
};

const MESSAGING =
  "the chat apps on the user's computer: the phone's chat is WhatsApp itself";
const MEDIA_OFF =
  "its toolset is off on the hosted bot, and audio or video cannot go to the chat";

/** The built-in tools the phone does not get, each with why. */
export const PHONE_EXCLUDED_MCP_TOOLS: Readonly<Record<string, string>> = {
  memory: "the phone keeps its own memory tool",
  todo: "one list for every session, lost on restart: the phone's memory tracks follow-ups",
  skill_manage: "writes skill files the user never sees",
  my_activity: "a bot's own chat only",
  image_generate: MEDIA_OFF,
  text_to_speech: MEDIA_OFF,
  video_generate: MEDIA_OFF,
  xai_video_edit: MEDIA_OFF,
  xai_video_extend: MEDIA_OFF,
  bfl_flux3_text_to_video: MEDIA_OFF,
  bfl_flux3_image_to_video: MEDIA_OFF,
  bfl_flux3_keyframes_to_video: MEDIA_OFF,
  bfl_flux3_video_continuation: MEDIA_OFF,
  bfl_flux3_get_result: MEDIA_OFF,
  bfl_flux3_prompting_guide: MEDIA_OFF,
  ha_list_entities: "a home on the user's own network",
  ha_get_state: "a home on the user's own network",
  ha_list_services: "a home on the user's own network",
  ha_call_service: "a home on the user's own network",
  list_whatsapp_chats: MESSAGING,
  send_whatsapp_message: MESSAGING,
  send_to_whatsapp: "the phone's chat is that WhatsApp: it answers there",
  read_whatsapp_messages: MESSAGING,
  list_telegram_chats: MESSAGING,
  send_telegram_message: MESSAGING,
  read_telegram_messages: MESSAGING,
  list_discord_chats: MESSAGING,
  send_discord_message: MESSAGING,
  read_discord_messages: MESSAGING,
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
 * reach when it was created, and confirmed by the user: the pages `web_fetch`
 * may read, the one page `browser_task` may open, and the connector reads it
 * may make. Fixed for the run; nothing the model reads widens it.
 */
export interface UnattendedPolicy {
  /**
   * The pages `web_fetch` may read (`https://news.example/tech/`): same
   * scheme, host and port, exactly the declared path, and no query.
   */
  sources: readonly string[];
  /** The page a watch routine reads, or null when it reads none. */
  watchUrl: string | null;
  /** What the routine asks about that page; the browser run is built from it. */
  watchPrompt?: string;
  /**
   * The connector reads this routine was given, by gateway tool and action;
   * none by default. Only those also in UNATTENDED_CONNECTOR_READS pass.
   */
  connectorReads?: Readonly<Record<string, readonly string[]>>;
  /**
   * The run starts with private data in hand (an event's payload: an email,
   * a webhook body). Every unattended run is held anyway (see fetchHold).
   */
  privateInput?: boolean;
  /** False when the run may read no files at all; absent, the folder's files. */
  files?: boolean;
}

/** How an allowed tool is checked in an unattended run. */
export type UnattendedRule =
  /** Local, and reads or tracks nothing outside the run. */
  | "allow"
  /** A read, inside the workspace only. */
  | "workspace-read"
  /** A URL under one of the declared sources (see sourceAllows). */
  | "sources"
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
  // The query reaches a REST search provider only, never a host the model
  // picks; a model's own search tool is refused (web/search.ts restOnly).
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
  web_fetch: "sources",
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
  send_to_whatsapp: NO_OUTPUT,
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
  browser_media: "send_media's check, run by the runtime; never a model's",
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
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  // An internationalized name compares in its ASCII form, as a URL holds it.
  if (![...bare].some((char) => char.charCodeAt(0) > 0x7f)) return bare;
  try {
    return new URL(`http://${bare}/`).hostname.replace(/\.$/, "");
  } catch {
    return bare;
  }
}

/** A table's own entry for a name, never one off Object's prototype. */
export function ownEntry<T>(
  table: Readonly<Record<string, T>>,
  name: string
): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * Hosts where anyone can publish a page or receive a request, so a prefix on
 * them is no fence: a declared source there would be a way out. Matched as
 * the host itself or any subdomain of it.
 */
export const MULTI_TENANT_HOSTS: readonly string[] = [
  "docs.google.com",
  "drive.google.com",
  "sites.google.com",
  "script.google.com",
  "script.googleusercontent.com",
  "forms.gle",
  "storage.googleapis.com",
  "firebaseapp.com",
  "web.app",
  "webhook.site",
  "requestbin.com",
  "requestcatcher.com",
  "beeceptor.com",
  "hookbin.com",
  "pipedream.net",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "trycloudflare.com",
  "workers.dev",
  "pages.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "glitch.me",
  "repl.co",
  "replit.app",
  "github.io",
  "gist.github.com",
  "gist.githubusercontent.com",
  "raw.githubusercontent.com",
  "pastebin.com",
  "paste.ee",
  "hastebin.com",
  "rentry.co",
  "dpaste.org",
  "ghostbin.com",
  "termbin.com",
  "transfer.sh",
  "0x0.st",
  "file.io",
  "s3.amazonaws.com",
  "blob.core.windows.net",
];

/** Whether a host is one anyone can publish on (see MULTI_TENANT_HOSTS). */
export function isMultiTenantHost(host: string): boolean {
  const wanted = normalizeHost(host);
  return MULTI_TENANT_HOSTS.some(
    (entry) => wanted === entry || wanted.endsWith(`.${entry}`)
  );
}

/**
 * A declared source as a URL prefix, or null when it cannot be one: http(s)
 * only, no credentials, never a multi-tenant host. A bare hostname (an older
 * routine's) is that host's https root. Query and fragment are dropped.
 */
export function sourcePrefix(raw: string): URL | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}/`
    );
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (normalizeHost(url.hostname).length === 0) return null;
  if (isMultiTenantHost(url.hostname)) return null;
  url.search = "";
  url.hash = "";
  return url;
}

/**
 * Whether `web_fetch` may read `raw` under the declared sources: same scheme,
 * exact host (no suffix, wildcard or subdomain match) and port, and a path
 * at or under the prefix's. A held run (every unattended one) may send
 * nothing it could leak: no query, and exactly a declared path.
 */
export function sourceAllows(
  raw: string,
  sources: readonly string[],
  held: boolean
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (held && url.search !== "") return false;
  return sources.some((source) => {
    const prefix = sourcePrefix(source);
    if (prefix == null) return false;
    if (
      url.protocol !== prefix.protocol ||
      normalizeHost(url.hostname) !== normalizeHost(prefix.hostname) ||
      url.port !== prefix.port
    )
      return false;
    if (held) return url.pathname === prefix.pathname;
    const base = prefix.pathname;
    return (
      url.pathname === base ||
      url.pathname.startsWith(base.endsWith("/") ? base : `${base}/`)
    );
  });
}

/** Whether `host` is exactly one of `allowed`: no suffix, wildcard or subdomain match. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const wanted = normalizeHost(host);
  return (
    wanted.length > 0 &&
    allowed.some((entry) => normalizeHost(entry) === wanted)
  );
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0
      )
    : [];

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
  const sources = stringList(record.sources)
    .map(sourcePrefix)
    .filter((prefix): prefix is URL => prefix != null)
    .map((prefix) => prefix.href);
  const watchUrl =
    typeof record.watchUrl === "string" && record.watchUrl.length > 0
      ? record.watchUrl
      : null;
  const reads: Record<string, string[]> = {};
  if (
    record.connectorReads != null &&
    typeof record.connectorReads === "object"
  )
    for (const [tool, actions] of Object.entries(
      record.connectorReads as Record<string, unknown>
    )) {
      const allowed = ownEntry(UNATTENDED_CONNECTOR_READS, tool) ?? [];
      const granted = stringList(actions).filter((action) =>
        allowed.includes(action)
      );
      if (granted.length > 0) reads[tool] = granted;
    }
  return {
    sources,
    watchUrl,
    ...(typeof record.watchPrompt === "string"
      ? { watchPrompt: record.watchPrompt }
      : {}),
    ...(Object.keys(reads).length > 0 ? { connectorReads: reads } : {}),
    ...(record.privateInput === true ? { privateInput: true } : {}),
    ...(record.files === false ? { files: false } : {}),
  };
}

/**
 * Whether a RESOLVED address is one we refuse to talk to. 169.254.169.254 is
 * where cloud providers serve instance credentials to any HTTP client on the
 * host. It takes an IP, never a hostname: `[::ffff:169.254.169.254]` normalizes
 * to hex with no dotted quad to match, and any DNS name can point at the
 * metadata IP (`metadata.google.internal` does).
 */
export function isBlockedAddress(address: string): boolean {
  const ip = unmapIpv4(address.replace(/^\[|\]$/g, "").toLowerCase());

  // IPv4 link-local, including the metadata address.
  if (ip.startsWith("169.254.")) return true;
  // IPv6 link-local: fe80::/10 (fe80–febf).
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;
  // IPv6 unique-local: fc00::/7 (fc00–fdff), which covers the fd00:ec2::254
  // form of the metadata address.
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

  return false;
}

/**
 * Whether a RESOLVED address is anything but the public internet: loopback,
 * private, carrier-grade NAT, link-local, unspecified or unique-local. Only a
 * fetch held to declared hosts refuses these; the rest of the time a dev
 * server on localhost is the normal case.
 */
export function isNonPublicAddress(address: string): boolean {
  const ip = unmapIpv4(address.replace(/^\[|\]$/g, "").toLowerCase());
  if (isBlockedAddress(ip)) return true;
  if (isIPv4(ip)) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      // Carrier-grade NAT.
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // IETF protocol assignments, and the three documentation ranges.
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      // Benchmarking (198.18.0.0/15).
      (a === 198 && (b === 18 || b === 19)) ||
      // Multicast, reserved and broadcast.
      a >= 224
    );
  }
  // Anything IPv6 that is not plain global unicast is refused: unspecified,
  // loopback, multicast, NAT64 (64:ff9b::/96 and 64:ff9b:1::/48, which reach
  // any IPv4 address, private ones included), 6to4 (2002::/16), Teredo
  // (2001::/32), documentation (2001:db8::/32), discard (100::/64), and the
  // old IPv4-compatible form (::a.b.c.d).
  const expanded = expandIpv6(ip);
  if (expanded == null) return true;
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0] = expanded;
  return (
    expanded.every((group) => group === 0) ||
    (expanded.slice(0, 7).every((group) => group === 0) && expanded[7] === 1) ||
    (h0 & 0xff00) === 0xff00 ||
    // Deprecated site-local (fec0::/10).
    (h0 & 0xffc0) === 0xfec0 ||
    (h0 === 0x64 && h1 === 0xff9b) ||
    h0 === 0x2002 ||
    (h0 === 0x2001 && (h1 === 0 || h1 === 0xdb8)) ||
    (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) ||
    expanded.slice(0, 6).every((group) => group === 0)
  );
}

/** An IPv6 address as its eight 16-bit groups, or null when it is not one. */
function expandIpv6(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;
  let text = ip.replace(/%.*$/, "");
  // A trailing dotted quad is the last two groups.
  const quad = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (quad != null) {
    const [, a, b, c, d] = quad.map(Number) as number[];
    text = `${text.slice(0, quad.index)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head.length > 0 ? head.split(":") : [];
  const back = tail != null && tail.length > 0 ? tail.split(":") : [];
  const missing = 8 - front.length - back.length;
  if (missing < 0 || (tail == null && missing !== 0)) return null;
  return [...front, ...Array<string>(missing).fill("0"), ...back].map((group) =>
    Number.parseInt(group, 16)
  );
}

/**
 * Unwrap an IPv4-mapped IPv6 address: `::ffff:a9fe:a9fe` and
 * `::ffff:169.254.169.254` both route to 169.254.169.254, so the range checks
 * have to see the dotted quad.
 */
function unmapIpv4(ip: string): string {
  const hexPair = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hexPair != null) {
    const high = Number.parseInt(hexPair[1]!, 16);
    const low = Number.parseInt(hexPair[2]!, 16);

    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }

  const dotted = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(ip);

  return dotted != null ? dotted[1]! : ip;
}
