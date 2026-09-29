import type { ToolDefinition } from "./definition";

/**
 * Scheduled work: routines a session or bot creates for itself.
 */
export const CRONJOB_TOOLS: ToolDefinition[] = [
  {
    name: "cronjob",
    toolsets: ["cronjob"],
    botAlways: true,
    description: [
      "Schedule the agent to run a prompt on its own: on a clock, on an incoming webhook, or both.",
      "",
      'Actions: "create" (prompt, and schedule and/or webhook: true; optional name), "list",',
      '"update" (id, and any of name/schedule/prompt/enabled), "pause" (id), "resume" (id),',
      '"remove" (id), "run" (id, to fire it now).',
      "",
      "When an update changes what a routine does, change its name to match in the same call.",
      'The name is what the user sees in the Routines panel and what you read back in "list";',
      "one that describes the old job is a routine both of you will misread later.",
      "",
      'Schedules are five-field cron in local time: "minute hour day month weekday".',
      '  "0 9 * * *"    every day at 09:00',
      '  "*/15 * * * *" every fifteen minutes',
      '  "0 9 * * 1"    Mondays at 09:00',
      "Names like MON are not supported, and neither is a seconds field.",
      "Reach for sensible defaults: pin loose asks to weekdays and waking hours unless the",
      "routine is about the user's life rather than their work, and inherit the current minute",
      'when the user names only an hour: asked at 1:32, "daily at 2" means "32 2 * * *".',
      "",
      "A routine with a schedule also fires once the moment it is created, whatever its",
      "schedule says, so the user sees it work instead of waiting out the first gap. Tell them",
      "so, and write the prompt so an off-schedule first run still makes sense.",
      "",
      "webhook: true makes the routine firable by an outside POST; the user copies its URL",
      "from the Routines panel. The request body arrives as data in the fire prompt.",
      "",
      "In a bot's own chat, routines you create belong to the bot and their fires are",
      "delivered back into this conversation. Everywhere else a fire starts a fresh session",
      "with no memory of this conversation, so write the prompt to stand alone.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "list",
            "update",
            "pause",
            "resume",
            "remove",
            "run",
          ],
        },
        id: { type: "string" },
        name: {
          type: "string",
          description:
            "Short display name for the Routines panel, on create or update.",
        },
        schedule: {
          type: "string",
          description: "Five-field cron expression.",
        },
        webhook: {
          type: "boolean",
          description:
            "create: also mint a webhook URL that fires this routine.",
        },
        prompt: {
          type: "string",
          description: "What to ask the agent when it fires.",
        },
        enabled: {
          type: "boolean",
          description: "update: enable or pause the job.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.cronjob(args, callerSession),
  },
];
