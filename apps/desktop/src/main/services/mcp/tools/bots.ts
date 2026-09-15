import type { ToolDefinition } from "./definition";

/**
 * What a bot knows about its own other conversations.
 */
export const BOTS_TOOLS: ToolDefinition[] = [
  {
    name: "my_activity",
    toolsets: "always",
    botAlways: true,
    description: [
      "Your own recent activity, across YOUR other conversations: your main",
      "chat with the user, your auto-reply chats, and your routine runs.",
      'Call it when the user asks what you have done, or when "so far"',
      "plainly reaches beyond this conversation — this chat's context does",
      "not follow you between conversations, but your work does.",
    ].join("\n"),
    inputSchema: { type: "object", properties: {} },
    run: (host, args, callerSession) => host.myActivity(callerSession),
  },
];
