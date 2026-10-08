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
      "so, and write the prompt so an off-schedule first run still makes sense. When this",
      "conversation has just done the routine's work itself, pass firstRun: false so it is",
      "not done twice.",
      "",
      "webhook: true makes the routine firable by an outside POST; the user copies its URL",
      "from the Routines panel. The request body arrives as data in the fire prompt.",
      "",
      "Every fire runs in a fresh session of its own, listed under Routines, and nothing",
      "from it reaches this conversation: write the prompt to stand alone, and never",
      "promise to report back here. In a bot's own chat the routine belongs to the bot",
      "and runs in its voice, with what the bot remembers.",
      "",
      'runner: "hosted" keeps the routine on the server: it runs on its own even while this',
      "computer is off, and results reach the user on WhatsApp or by email.",
      '"local" runs it in this app, only while it is open. Leave it out and the app picks.',
      'A hosted routine never fires on create: offer one test run ("run") instead. For a',
      "hosted one also give timezone (the user's IANA zone; ask if you do not know it) and,",
      "where they apply: kind (reminder: reminder_text sent as written at the time, nothing",
      "runs; task; watch: watch_url, the one page it reads; event: webhook), run_at for a",
      "one-time moment (ISO 8601; without an offset it is the user's wall time), notify:",
      '"relevant" to deliver only when its condition holds.',
      "",
      "Every routine's runs are unattended: they search the web and read, and cannot send",
      "messages, change files, pay, or make routines. Give what a run may read: sources,",
      "the page addresses it may read under (https://news.example.com/tech/), and reads,",
      'the account data it may read ("gmail.search", "gmail.read", "calendar.read"), only',
      "what the routine needs; nothing else is reachable. A routine that runs on its own",
      "starts only once the user allows it at a link: give them the link, and say it",
      'starts once allowed ("approval_link" with its id gets a fresh one).',
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
            "approval_link",
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
        firstRun: {
          type: "boolean",
          description:
            "create: false skips the fire on creation, for a routine whose first pass this conversation has just done.",
        },
        runner: {
          type: "string",
          enum: ["hosted", "local"],
          description:
            "create: where it runs; leave it out for the app's default.",
        },
        kind: {
          type: "string",
          enum: ["reminder", "task", "watch", "event"],
          description: "create, hosted: what it is.",
        },
        timezone: {
          type: "string",
          description:
            "hosted: the IANA zone its schedule is read in, e.g. Asia/Kolkata.",
        },
        run_at: {
          type: "string",
          description:
            "hosted: a one-time moment, ISO 8601, instead of a schedule.",
        },
        reminder_text: {
          type: "string",
          description: "hosted reminder: the message sent as written.",
        },
        notify: {
          type: "string",
          enum: ["always", "relevant"],
          description:
            "hosted: relevant delivers only when the routine's condition holds.",
        },
        delivery: {
          type: "string",
          enum: ["whatsapp", "email", "panel"],
          description:
            "hosted: where results go; leave it out for WhatsApp, else email.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "The page addresses a run may read under, e.g. https://news.example.com/tech/.",
        },
        reads: {
          type: "array",
          items: {
            type: "string",
            enum: ["gmail.search", "gmail.read", "calendar.read"],
          },
          description: "The account data a run may read; none unless given.",
        },
        watch_url: {
          type: "string",
          description: "hosted watch: the one page a run opens and reads.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.cronjob(args, callerSession),
  },
];
