import { catalogByKind } from "@abacus-ai/connectors/describe";

import type { ToolDefinition } from "./definition";

const names = catalogByKind();

/**
 * Attaching and detaching Abacus.AI connector accounts.
 */
export const CONNECTORS_TOOLS: ToolDefinition[] = [
  {
    name: "connect_connector",
    toolsets: ["connectors"],
    description: [
      "The user's connectors (every entry on the Connectors page) and the way to",
      "get one connected without ending the turn. They are the account connectors",
      `(${names.platform.join(", ")}), ${names.credential.join(", ")} (a token),`,
      `the chat apps (${names.messaging.join(", ")}) and the tool servers`,
      `(${names.mcp.join(", ")}).`,
      "",
      "A tool server is a connector like any other: asking for it puts the same",
      "Connect button up, connecting installs it on this machine, and its tools",
      "then appear in your tool list. Never tell the user a name on this list is",
      "not a connector, and never install one by hand.",
      "",
      "The chat apps (WhatsApp, Telegram and Discord) are in this list",
      "too, with whether they are linked, and asking for one puts the same Connect",
      "button in the chat. Linking one opens its own sign-in, usually a QR code the",
      "user scans with their phone, so the call waits longer than most.",
      "",
      "Call it with no arguments to see every connector on this machine, each marked",
      "connected or not, and each connected one named with the account behind it:",
      'that account is who the user means by "me", so read it here instead of asking.',
      "Call it with a service to ask for that one: the user gets a",
      "Connect button in the chat and this call waits for them, then tells you what",
      "happened. Every connector is available to every chat. Do not report that you",
      "cannot do something for want of a connector until you have asked for it this way.",
      "",
      "When the task plainly needs a missing service, call this immediately: the",
      "button is the question. Do not ask permission first, do not offer",
      '"connect X" as one item in a menu, and do not end the turn saying something',
      "is missing without the button already up.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            'The service to ask for, e.g. "slack". Omit to list what exists.',
        },
        reason: {
          type: "string",
          description:
            "One line on why you need it, shown to the user under the button.",
        },
      },
    },
    run: (host, args, callerSession) =>
      host.connectConnector(args, callerSession),
  },
  {
    name: "disconnect_connector",
    toolsets: ["connectors"],
    description: [
      "Disconnect one connector, when the user asks for that: an account",
      "connector (Gmail, Google Calendar, Drive, ...) is detached from their",
      "account; a chat app (WhatsApp, Telegram, Discord) is switched off.",
      "",
      "Only on the user's explicit request. Never disconnect anything on",
      "your own judgement. It undoes cleanly: connect_connector reattaches an",
      "account connector, and switches a chat app back on. Before disconnecting",
      "something a routine of yours depends on, say what will break.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        service: {
          type: "string",
          description:
            'The service to disconnect, e.g. "googlecalendar" or "whatsapp".',
        },
      },
      required: ["service"],
    },
    run: (host, args) => host.disconnectConnector(args),
  },
];
