import { OVERNIGHT_TOOL } from "@abacus-ai/contract/overnight";

import type { ToolDefinition } from "./definition";

/**
 * `overnight_task`: books the work the user said yes to on the next step's
 * moon button (overnight.ts) as a one-time routine that reports into this
 * chat, brought up the next morning; the model only writes the plan and tells.
 */
export const OVERNIGHT_TOOLS: ToolDefinition[] = [
  {
    name: OVERNIGHT_TOOL,
    toolsets: "always",
    botsOnly: true,
    appBotChatOnly: true,
    sessionsWhen: (host) => host.nextStep,
    offered: (host) => host.nextStep,
    description: [
      "Book a piece of this chat's work to be done overnight, once, so it is ready for the user tomorrow morning.",
      "Call it only when the user just tapped or wrote yes to an overnight task you offered under a result",
      "(suggest_tasks, overnight: true), never on your own and never for work they want now.",
      "task: one short line in the user's language naming what will be ready, with the project's name",
      '("Version 2 of Maya\'s Breads: phone layout, order form, two hero designs").',
      "plan: the whole job for a fresh run that has not seen this chat: the project's folder and files by",
      "absolute path, what was built so far and what the user wants (their words, names, style), each change to",
      "make, and the one choice to leave for the user (two versions of one thing to pick from). Keep it to one",
      "focused pass: no new accounts, no payments, nothing sent to anyone.",
      "The result says when it will be ready. Then tell the user in one or two short lines, in their language: when",
      "it will be ready, that it runs on this computer, and that if the app is closed then it will be done a few",
      "minutes after they open it. Do not start the work now.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "What will be ready, one line in the user's language, naming the project.",
        },
        plan: {
          type: "string",
          description: "What the overnight run does, in full.",
        },
      },
      required: ["task", "plan"],
    },
    run: (host, args, callerSession) => {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      const plan = typeof args.plan === "string" ? args.plan.trim() : "";
      if (task.length === 0 || plan.length === 0)
        return host.err("Pass task and plan, both non-empty.");
      if (callerSession == null)
        return host.err("Only a chat in the app can book overnight work.");
      return host.bookOvernight(callerSession, task, plan);
    },
  },
];
