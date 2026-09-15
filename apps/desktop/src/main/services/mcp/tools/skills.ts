import type { ToolDefinition } from "./definition";

/**
 * Skills: what is installed, and how to read or edit one.
 */
export const SKILLS_TOOLS: ToolDefinition[] = [
  {
    name: "skills_list",
    toolsets: ["skills"],
    description:
      "List the skills available in this workspace and globally, with their descriptions.",
    inputSchema: { type: "object", properties: {} },
    run: (host) => host.skillsList(),
  },
  {
    name: "skill_view",
    toolsets: ["skills"],
    description:
      "Read a skill's full instructions. Use skills_list first to find its id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The skill id from skills_list." },
      },
      required: ["id"],
    },
    run: (host, args) => host.skillView(String(args.id ?? "")),
  },
  {
    name: "skill_manage",
    toolsets: ["skills"],
    description:
      "Open a skill file for editing. Returns the path so it can be read or written with the file tools.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The skill id from skills_list." },
      },
      required: ["id"],
    },
    run: (host, args) => host.skillManage(String(args.id ?? "")),
  },
];
