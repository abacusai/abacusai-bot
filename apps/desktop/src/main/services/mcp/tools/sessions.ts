import type { ToolDefinition } from "./definition";

/**
 * `offer_session`: a bot asked to build hands the work to a session. The
 * call draws a card in the bot's chat (the renderer reads its arguments);
 * opening it starts a session with the task in its message box.
 */
export const SESSIONS_TOOLS: ToolDefinition[] = [
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
