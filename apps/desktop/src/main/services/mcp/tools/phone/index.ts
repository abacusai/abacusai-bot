import {
  PHONE_AGENT_TOOL_NAMES,
  PHONE_VAULT_TOOL_NAMES,
} from "@abacus-ai/agent/tool-policy";

import { PHONE_CONNECTORS_TOOLS } from "./connectors";
import type { PhoneToolDefinition } from "./definition";

/**
 * Every agent-tools tool the WhatsApp chat sees, each in its phone words.
 * A tool missing here is not on the phone, whatever the app serves.
 */
export const PHONE_AGENT_TOOLS: readonly PhoneToolDefinition[] = [
  ...PHONE_CONNECTORS_TOOLS,
];

/**
 * Phone tools that still read the app's definition while theirs is written,
 * one by one.
 *
 * SHRINK ONLY. Remove a name when its phone definition lands; never add one.
 * agent-tools-phone-owned.test.ts holds a frozen copy of the largest this
 * list may be and its length, and fails on any name or entry added here.
 */
export const NOT_YET_PHONE_OWNED: readonly string[] = [
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
];

/**
 * The vault's tools reach the phone from the browser server, still in its
 * one wording while their phone definitions are written (with the browser's
 * phone texts). SHRINK ONLY, like the list above; the phone tools test holds
 * a frozen copy.
 */
export const NOT_YET_PHONE_OWNED_VAULT: readonly string[] = [
  "vault_items",
  "vault_request",
  "payment_approval",
  "signin_approval",
];

const byName = new Map<string, PhoneToolDefinition>();
for (const definition of PHONE_AGENT_TOOLS) {
  if (byName.has(definition.name))
    throw new Error(`agent-tools: phone ${definition.name} is defined twice`);
  byName.set(definition.name, definition);
}

export const phoneAgentTool = (name: string): PhoneToolDefinition | undefined =>
  byName.get(name);

// The roster the agent's policy names is exactly the phone's definitions
// plus the not-yet list: neither can drift from the other.
const roster = new Set([
  ...PHONE_AGENT_TOOLS.map((definition) => definition.name),
  ...NOT_YET_PHONE_OWNED,
]);
if (
  roster.size !== PHONE_AGENT_TOOL_NAMES.length ||
  PHONE_AGENT_TOOL_NAMES.some((name) => !roster.has(name))
)
  throw new Error(
    "agent-tools: the phone's definitions and PHONE_AGENT_TOOL_NAMES differ"
  );
if (
  PHONE_VAULT_TOOL_NAMES.length !== NOT_YET_PHONE_OWNED_VAULT.length ||
  PHONE_VAULT_TOOL_NAMES.some(
    (name) => !NOT_YET_PHONE_OWNED_VAULT.includes(name)
  )
)
  throw new Error(
    "agent-tools: every phone vault tool needs a phone definition or a not-yet entry"
  );
