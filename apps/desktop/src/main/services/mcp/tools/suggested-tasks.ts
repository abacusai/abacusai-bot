import {
  SUGGEST_TASKS_TOOL,
  SUGGESTED_TASK_MAX_CHARS,
  SUGGESTED_TASKS_MAX,
  suggestedTasks,
} from "@abacus-ai/contract/bots/suggested-tasks";

import type { ToolDefinition } from "./definition";

/**
 * `suggest_tasks`: a reply ends with tasks the user taps instead of typing.
 * The call draws the buttons under the reply (the renderer reads its
 * arguments); a tap sends the button's text as the user's next message.
 */
export const SUGGESTED_TASKS_TOOLS: ToolDefinition[] = [
  {
    name: SUGGEST_TASKS_TOOL,
    toolsets: "always",
    botsOnly: true,
    appBotChatOnly: true,
    description: [
      `End your reply with ${SUGGESTED_TASKS_MAX - 1} or ${SUGGESTED_TASKS_MAX} tasks the user can tap to run, instead of asking them to type. Each`,
      "task shows as a button under your reply; tapping it sends its text to you as the user's message, and you do it.",
      "Call it, as the last thing in your reply, after your text:",
      '- when the user greets you ("hi", "hello") or asks what you can do or how you can help: answer in a line or two',
      "  and offer tasks instead of listing abilities;",
      "- whenever your reply, the first one in this chat included, would otherwise end by reporting that there was",
      "  nothing to do, or by waiting on something only they can do (a connection, a sign-in): offer what you can do",
      "  meanwhile.",
      "Do not call it after a reply that simply answers what was asked, or when one short question about what they",
      "want (a topic, what to work on first) is the natural next step: ask it instead.",
      "",
      "Each task is a concrete request you can carry out right away with what is connected, written as the user",
      `would say it, in their language, at most ${SUGGESTED_TASK_MAX_CHARS} characters: "Draft replies to my two unread client emails",`,
      '"Make me a one-page website for my bakery", not "Email help" or "Something else". Never a task that needs a',
      "connector that is not connected; never a task that sends, pays or deletes anything without saying so plainly.",
      "Mark a task copy: true when it is a message for the user to send you from their phone (WhatsApp, Telegram or",
      "Discord): the button copies it instead. Do not repeat the tasks in your text, and write nothing after this call.",
      "Never call it in a reply to a message that came from a chat app: only this app's chat shows the buttons.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          maxItems: SUGGESTED_TASKS_MAX,
          description: "The tasks, the likeliest first.",
          items: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: `The request, as the user would type it, in their language. One line, at most ${SUGGESTED_TASK_MAX_CHARS} characters.`,
              },
              copy: {
                type: "boolean",
                description:
                  "True for a message the user sends you from their phone: the button copies it.",
              },
            },
            required: ["text"],
          },
        },
      },
      required: ["tasks"],
    },
    run: (host, args) => {
      const tasks = suggestedTasks(args);
      if (tasks.length === 0)
        return host.err(
          `Pass tasks: ${SUGGESTED_TASKS_MAX - 1} or ${SUGGESTED_TASKS_MAX} requests, each one line of at most ${SUGGESTED_TASK_MAX_CHARS} characters.`
        );
      const dropped =
        Array.isArray(args.tasks) && args.tasks.length > tasks.length
          ? ` ${args.tasks.length - tasks.length} were left out (empty, repeated, too long or more than ${SUGGESTED_TASKS_MAX}).`
          : "";
      return host.ok(
        `The user sees ${tasks.length} button${tasks.length === 1 ? "" : "s"} under your reply.${dropped} ` +
          "Your reply is complete: write nothing more in this turn."
      );
    },
  },
];
