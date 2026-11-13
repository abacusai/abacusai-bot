import type { ToolDefinition } from "./definition";

/**
 * `github_fix`: the user's answer to a GitHub watcher ping ("fix", "review
 * it") starts the work in that repo's project on this computer. Listed only
 * for the user's own chats with a bot, and only while they allow it.
 */
export const GITHUB_WATCH_TOOLS: ToolDefinition[] = [
  {
    name: "github_fix",
    toolsets: "always",
    botsOnly: true,
    offered: (host) => host.githubFix === true,
    description: [
      "Start fixing (or reviewing) something the app's GitHub watcher told the user about: a failed CI run, new review",
      "comments on their pull request, or a new pull request to review. Call it when a [github watch] note is in the",
      "user's message and they ask you to fix, review or go ahead. It starts a separate session on their computer in",
      "that repository's project; its result is sent to their chat when it ends. Do not do the work yourself.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        event_id: {
          type: "string",
          description:
            "The event_id from the [github watch] note; leave it out for the newest one not yet fixed.",
        },
      },
    },
    run: (host, args, callerSession) => host.githubFix(args, callerSession),
  },
];
