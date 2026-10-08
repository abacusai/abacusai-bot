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
 * one by one. It only shrinks: the phone tools test fails on a name added
 * here, and on any phone tool that is in neither list.
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

const byName = new Map<string, PhoneToolDefinition>();
for (const definition of PHONE_AGENT_TOOLS) {
  if (byName.has(definition.name))
    throw new Error(`agent-tools: phone ${definition.name} is defined twice`);
  byName.set(definition.name, definition);
}

export const phoneAgentTool = (name: string): PhoneToolDefinition | undefined =>
  byName.get(name);
