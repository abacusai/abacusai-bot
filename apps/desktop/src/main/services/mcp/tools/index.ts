import { BOTS_TOOLS } from "./bots";
import { CONNECTORS_TOOLS } from "./connectors";
import { CRONJOB_TOOLS } from "./cronjob";
import type { ToolDefinition } from "./definition";
import { DELIVERABLES_TOOLS } from "./deliverables";
import { DOCUMENTS_TOOLS } from "./documents";
import { INTEGRATIONS_TOOLS } from "./integrations";
import { MEDIA_TOOLS } from "./media";
import { MEMORY_TOOLS } from "./memory";
import { MESSAGING_TOOLS } from "./messaging";
import { SKILLS_TOOLS } from "./skills";
import { TODO_TOOLS } from "./todo";

/**
 * Every tool the agent-tools server serves, one definition each: schema,
 * which Capabilities toggle governs it, who may see it, and what runs. The
 * server derives listing and dispatch from this list and nothing else, so a
 * tool that exists here is advertised and callable, and one that does not is
 * neither — there is no second table to forget.
 */
export const AGENT_TOOLS: readonly ToolDefinition[] = [
  ...SKILLS_TOOLS,
  ...TODO_TOOLS,
  ...MEMORY_TOOLS,
  ...CRONJOB_TOOLS,
  ...MEDIA_TOOLS,
  ...INTEGRATIONS_TOOLS,
  ...DOCUMENTS_TOOLS,
  ...DELIVERABLES_TOOLS,
  ...CONNECTORS_TOOLS,
  ...BOTS_TOOLS,
  ...MESSAGING_TOOLS,
];

const byName = new Map<string, ToolDefinition>();
for (const definition of AGENT_TOOLS) {
  if (byName.has(definition.name))
    throw new Error(`agent-tools: ${definition.name} is defined twice`);
  byName.set(definition.name, definition);
}

export const agentTool = (name: string): ToolDefinition | undefined =>
  byName.get(name);

export const AGENT_TOOL_NAMES: readonly string[] = AGENT_TOOLS.map(
  (definition) => definition.name
);
