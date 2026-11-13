import {
  SUGGEST_TASKS_TOOL,
  SUGGESTED_TASK_MAX_CHARS,
  SUGGESTED_TASKS_MAX,
  suggestedTasks,
} from "@abacus-ai/contract/bots/suggested-tasks";

import type { ToolDefinition } from "./definition";

/** How the tool reads everywhere, and all it says outside the next step's half. */
const BASE_DESCRIPTION = [
  `End your reply with ${SUGGESTED_TASKS_MAX - 1} or ${SUGGESTED_TASKS_MAX} tasks the user can tap to run, instead of asking them to type. Each`,
  "task shows as a button under your reply; tapping it sends its text to you as the user's message, and you do it.",
  "Call it, as the last thing in your reply, after your text:",
  '- when the user greets you ("hi", "hello") or asks what you can do or how you can help: answer in a line or two',
  "  and offer tasks instead of listing abilities;",
  "- whenever your reply, the first one in this chat included, would otherwise end by reporting that there was",
  "  nothing to do, or by waiting on something only they can do (a connection, a sign-in): offer what you can do",
  "  meanwhile.",
  "Do not call it after a reply that simply answers what was asked, or when one short question about what they",
  "want (a topic, what to work on first) is the natural next step: ask it instead, unless your instructions say",
  "to pick it yourself and offer the alternatives as tasks.",
  "",
  "Each task is a concrete request you can carry out right away with what is connected, written as the user",
  `would say it, in their language, at most ${SUGGESTED_TASK_MAX_CHARS} characters: "Draft replies to my two unread client emails",`,
  '"Make me a one-page website for my bakery", not "Email help" or "Something else". Never a task that needs a',
  "connector that is not connected; never a task that sends, pays or deletes anything without saying so plainly.",
  "Mark a task copy: true when it is a message for the user to send you from their phone (WhatsApp, Telegram or",
  "Discord): the button copies it instead. Do not repeat the tasks in your text. This call ends your turn, so write",
  "everything you have to say before it.",
  "Never call it in a reply to a message that came from a chat app: only this app's chat shows the buttons.",
];

/** A finished piece of work ends on what comes next (next-step.ts). */
const NEXT_STEP_DESCRIPTION = [
  "",
  "After a result, there is one more time to call it. A result is real work you finished in this turn and that",
  "worked: a site, a file, a document, a report, a fix, a pass over an inbox. End that reply with one short, specific",
  "question naming the likeliest next step, then call this with after_result: true and one or two tasks that answer",
  "it: the question may name what a task says. This call takes one task too. Offer:",
  "- the next piece of this same work, the one thing the user would most plausibly want now (a site that only",
  "  exists on this computer goes online first). When the work is built on placeholder or sample content (made-up",
  '  names, stock text, demo projects), that piece is putting the user\'s own in: "Put my real name and projects in";',
  '- and, only where the work repeats, one task marked routine: true, in words that name when it runs: "Every',
  '  morning at 9, sum up my new orders", "Every Monday, find new job ads that fit my CV", "Every night, run my',
  "  tests and fix what fails\". Work that watches something that changes (job ads, prices, a market, a script's",
  "  signals, mail, a live site, a project's tests or pull requests) repeats. Pick the rhythm the thing really",
  "  changes at, weekly unless it changes every day: each run spends the user's credits.",
  "A routine task must be one a routine can do today with what is connected, and not one that already exists. If",
  "the source it needs is not connected, the next step is connecting it, never the routine. When a routine task is",
  "tapped, create it with cronjob and firstRun: false, then say in a line when it first runs and that it runs while",
  "this app is open.",
  "When your reply already ends on a question about what comes next, the tasks answer that question and you",
  "write no more text. Not after a plain answer, a failure or a refusal, not when your question asks for something",
  "only the user can give (their name, a file, a choice you cannot guess), not when your reply shows another card,",
  "and not when your last reply ended with after_result and the user did not take it up.",
  "In a reply to a message from a chat app, write the question and make no call.",
];

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
    sessionsWhen: (host) => host.nextStep,
    description: (_channel, host) =>
      [
        ...BASE_DESCRIPTION,
        ...(host.nextStep ? NEXT_STEP_DESCRIPTION : []),
      ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        after_result: {
          type: "boolean",
          description: "True for the next step under a finished result.",
        },
        tasks: {
          type: "array",
          minItems: 1,
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
              routine: {
                type: "boolean",
                description:
                  "True for a task that asks for a routine: the button shows a clock.",
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
      if (tasks.some((task) => task.routine) && host.routineOfferClosed())
        return host.err(
          "The user's free credits are nearly used, and a routine spends them on every run. Call this again without the routine task."
        );
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
          "If you have not written your reply yet, write it now; never repeat what you already wrote."
      );
    },
  },
];
