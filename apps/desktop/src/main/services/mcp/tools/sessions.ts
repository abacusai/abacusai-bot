import type { ToolDefinition } from "./definition";

/**
 * `hand_off_session`: a chat moves a task of its own into a new chat that
 * runs beside it, on the same folder, worktree, model and mode. The renderer
 * draws the call as a card that follows the new chat.
 */
const HAND_OFF_SESSION: ToolDefinition = {
  name: "hand_off_session",
  toolsets: "always",
  appChatOnly: true,
  description: [
    "Start a separate task in a new chat that runs beside this one, in the same folder with the same model and mode.",
    "The task starts at once and the user follows it from a card here and from the sidebar, where it sits under this chat.",
    "Call it only when it is needed:",
    "- the user asks for it: to split something off, do it separately, in parallel or in its own chat or session;",
    "- or a task of its own comes up that does not need this conversation's result and would take long enough to be",
    "  worth running at the same time (another bug, another feature, another document), and the user agreed or asked",
    "  for everything to be done.",
    "Never call it for a step of the current task, for something a few tool calls finish, for a question, or to split",
    "one task into pieces: do those here (delegate_task is for a helper whose result you need back). Never call it",
    "twice for the same task. When in doubt, do the work here.",
    "The new chat knows nothing of this one: write prompt as a complete brief.",
    "Afterwards tell the user in one short line, in their language, what you started there, and carry on with the rest here.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "The new chat's name in the sidebar: the task in a few words, in the user's language.",
      },
      prompt: {
        type: "string",
        description:
          "The new chat's first message, its whole brief, in the user's language: what to do, every detail the user gave, the files or places involved, what is already known or decided here, and what done looks like.",
      },
    },
    required: ["title", "prompt"],
  },
  run: (host, args, callerSession) => host.handOffSession(args, callerSession),
};

/**
 * `offer_session`: a bot asked to build hands the work to a session. The
 * call draws a card in the bot's chat (the renderer reads its arguments);
 * opening it starts a session with the task in its message box.
 */
export const SESSIONS_TOOLS: ToolDefinition[] = [
  HAND_OFF_SESSION,
  {
    name: "offer_session",
    toolsets: "always",
    botsOnly: true,
    appBotChatOnly: true,
    description: [
      "Offer to build something in a session, where you can write files in a folder, run code and show the result in a",
      "preview. Call it when the user asks you to write or fix code across files, build an app, site, page, game, tool or",
      "script, or work on a repository or folder, and when they ask whether you can code or build things. Answer small",
      "code questions (a snippet, a regex, explaining an error) here instead. It shows the user a card with a button that",
      "opens the session with the task ready to send. Then say in one short line, in their language, that it is best",
      "built in a session and they can open it with the button. Do not ask them to describe the project first, and do",
      "not start building here. Offer once for a request: one card, even if the work has several parts.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "What gets built, in a few words, in the user's language: the card's heading.",
        },
        prompt: {
          type: "string",
          description:
            "The task for the session, written as the user's own request in their language, with every detail they gave. When they only asked whether you can code, a short invitation to describe what to build.",
        },
      },
      required: ["title", "prompt"],
    },
    run: (host, args) =>
      typeof args.prompt === "string" && args.prompt.trim().length > 0
        ? host.ok(
            "The card is in the chat. Tell the user in one short line, in their language, that they can open the session with its button; do not build it here."
          )
        : host.err("Pass prompt: the task for the session."),
  },
];
