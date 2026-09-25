import {
  homeAssistantReady,
  xSearchReady,
} from "../../agent-tools/integrations";
import type { ToolDefinition } from "./definition";

/**
 * Third-party services behind a credential: X search, Home Assistant.
 */
export const INTEGRATIONS_TOOLS: ToolDefinition[] = [
  {
    name: "x_search",
    toolsets: ["x_search"],
    ready: xSearchReady,
    description:
      "Search public posts and threads on X. Returns a summary with links.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    run: (host, args) => host.xSearch(args),
  },
  {
    name: "ha_list_entities",
    toolsets: ["homeassistant"],
    ready: homeAssistantReady,
    description:
      "List Home Assistant entities and their current state. Filter to avoid a wall of output.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Substring to match on id or friendly name.",
        },
      },
    },
    run: (host, args) => host.homeAssistant("ha_list_entities", args),
  },
  {
    name: "ha_get_state",
    toolsets: ["homeassistant"],
    ready: homeAssistantReady,
    description: "Read one entity's state and full attributes.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: { type: "string", description: "e.g. light.kitchen" },
      },
      required: ["entity_id"],
    },
    run: (host, args) => host.homeAssistant("ha_get_state", args),
  },
  {
    name: "ha_list_services",
    toolsets: ["homeassistant"],
    ready: homeAssistantReady,
    description: "List services that can be called, optionally for one domain.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "e.g. light" } },
    },
    run: (host, args) => host.homeAssistant("ha_list_services", args),
  },
  {
    name: "ha_call_service",
    toolsets: ["homeassistant"],
    ready: homeAssistantReady,
    description:
      "Call a Home Assistant service to change something. This affects real devices in the user's home. Be sure before calling it.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. light" },
        service: { type: "string", description: "e.g. turn_on" },
        entity_id: { type: "string" },
        data: {
          type: "object",
          description: "Extra service data, e.g. brightness.",
        },
      },
      required: ["domain", "service"],
    },
    run: (host, args) => host.homeAssistant("ha_call_service", args),
  },
];
