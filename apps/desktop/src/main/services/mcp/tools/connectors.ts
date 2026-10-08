import {
  catalogByKind,
  describeForListing,
} from "@abacus-ai/connectors/describe";

import type { ConnectOutcome, DisconnectOutcome } from "./connect-outcome";
import type { ToolDefinition, ToolHost, ToolResult } from "./definition";

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
      "get one connected without ending or holding the turn. They are the account connectors",
      `(${names.platform.join(", ")}),`,
      `the chat apps (${names.messaging.join(", ")}) and the tool servers`,
      `(${names.mcp.join(", ")}).`,
      "",
      "A tool server is a connector like any other: asking for it puts the same",
      "Connect card up in the app, connecting installs it on this machine, and its tools",
      "then appear in your tool list. Never tell the user a name on this list is",
      "not a connector, and never install one by hand.",
      "",
      "The chat apps (WhatsApp, Telegram and Discord) are in this list",
      "too, with whether they are linked, and asking for one puts the same Connect",
      "card in the chat. Linking one opens its own sign-in, usually a QR code the",
      "user scans with their phone.",
      "",
      "Call it with no arguments to see every connector on this machine, each marked",
      "connected or not, and each connected one named with the account behind it:",
      'that account is who the user means by "me", so read it here instead of asking.',
      "Call it with a service to ask for that one. It answers at once, never waiting",
      "for the user: an account connector comes back as a one-tap link to send them",
      "(one Google sign-in covers Gmail, Drive and Calendar), and in the app a Connect",
      "card shows too. Carry on meanwhile; you are told when it is connected, and its",
      "tools are in your list then. Every connector is available to every chat. Do not",
      "report that you cannot do something for want of a connector until you have asked.",
      "",
      "When the task plainly needs a missing service, call this immediately: the",
      "link is the question. Do not ask permission first, do not offer",
      '"connect X" as one item in a menu, and do not end the turn saying something',
      "is missing without having sent the link.",
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
            "One line on why you need it, shown to the user on the Connect card.",
        },
      },
    },
    run: async (host, args, callerSession) =>
      appConnectResult(
        host,
        await host.connectConnectorOutcome(args, callerSession, {
          card: true,
        })
      ),
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
    run: async (host, args) =>
      appDisconnectResult(
        host,
        await host.disconnectConnectorOutcome(args, { chatApps: true })
      ),
  },
];

/** What an app chat's model is told about an ask. */
export function appConnectResult(
  host: Pick<ToolHost, "ok" | "err">,
  outcome: ConnectOutcome
): ToolResult {
  switch (outcome.code) {
    case "no_connectors":
      return host.err("Connectors are not available in this session.");
    case "list":
      return host.ok(
        [
          "Connectors available in this chat:",
          "",
          ...outcome.entries.map(({ connector, status }) =>
            describeForListing(connector, status)
          ),
          "",
          "A connector listed as connected is one whose tools are already in your",
          "tool list. Use those; do not guess a tool name. Where it says what it is",
          "connected as, that is the user's own account on that service: it is who",
          '"me" and "myself" mean, so do not ask them for it.',
        ].join("\n")
      );
    case "ambiguous":
      return host.ok(
        `"${outcome.asked}" matches more than one connector: ${outcome.options
          .map((item) => `${item.name} (${item.id})`)
          .join(", ")}. Ask again with one of those.`
      );
    case "unknown":
      return host.ok(
        `There is no connector called "${outcome.asked}". Available: ${outcome.options
          .map((item) => `${item.name} (${item.id})`)
          .join(", ")}.`
      );
    case "connected": {
      const account = outcome.account != null ? ` as ${outcome.account}` : "";
      if (outcome.kind === "messaging")
        return host.ok(
          `${outcome.name} is connected. Send, list and read with its own tools ` +
            "(send_<platform>_message, list_<platform>_chats, read_<platform>_messages). Do not ask the user to " +
            "connect anything."
        );
      if (outcome.via != null)
        return host.ok(
          `${outcome.name} is already connected${account}, so ${outcome.via} ` +
            "are authenticated as the user. Use them: there is nothing to ask the user for."
        );
      return host.ok(
        `${outcome.name} is already connected${account}. Use it: ` +
          "there is nothing to ask the user for, and that account is who they mean " +
          'by "me". Its tools are already in your tool list; use those rather than ' +
          "guessing a tool name."
      );
    }
    case "unavailable": {
      const why =
        outcome.reason === "not-signed-in"
          ? "the app is not signed in to Abacus.AI"
          : outcome.reason === "not-offered"
            ? "the user's Abacus.AI account does not offer it"
            : "it cannot be reached right now";
      return host.ok(
        `${outcome.name} cannot be connected from here: ${why}. Say so, and offer whatever ` +
          "part of the task does not need it."
      );
    }
    case "no_link":
      return host.ok(
        !outcome.card
          ? `${outcome.name} is connected from Connectors in the AbacusAI Bot app. Tell the user so, and offer whatever part of the task does not need it.`
          : `A Connect card for ${outcome.name} is in front of the user in the app. Say in one short line that it needs connecting there, ` +
              "then carry on with whatever does not need it: this call does not wait, and you will be told when it is connected."
      );
    case "reconnect":
      return host.ok(
        [
          `The account reports ${outcome.names.join(", ")} as already connected with every permission, ` +
            "though this machine's list has not caught up yet. If their tools are in your tool list, use them and do not " +
            "send anything. Only if they are missing or fail for lack of access, send the user this link to reconnect them:",
          outcome.url,
          "",
          "Put it in a message of its own with one short line in the user's language, saying it reconnects the account. " +
            "Copy it exactly; never shorten or reword it. This call does not wait: you will be told when the reconnect " +
            "lands. Never offer to flag or report anything: there is no such process.",
        ].join("\n")
      );
    case "link":
      return host.ok(linkText(outcome));
  }
}

/** The link result, shared by every surface: it already speaks only of the link. */
export function linkText(
  outcome: Extract<ConnectOutcome, { code: "link" }>
): string {
  const { asking, already, url } = outcome;
  const covered = asking.join(", ");
  const connected = already.join(", ");
  return [
    ...(already.length > 0
      ? [
          `${connected} ${already.length > 1 ? "are" : "is"} already connected; ${already.length > 1 ? "their" : "its"} tools are in your tool list. ` +
            `Still to connect: ${covered}. This link asks only for ${asking.length > 1 ? "those" : "that"}.`,
        ]
      : []),
    `Send the user this link to connect ${asking.length > 1 ? `${covered}, all in one step` : covered}:`,
    url,
    "",
    "Put it in a message of its own with one short line in the user's language. Copy it exactly; never shorten or reword it. " +
      "It opens the provider's own sign-in, and stays connected after that." +
      (asking.length > 1
        ? " The sign-in screen may show a checkbox for each; whatever is left unticked is not connected."
        : ""),
    "This call does not wait. Carry on with whatever does not need it. When it lands you will be told exactly what " +
      "connected and anything that was not allowed, and its tools appear in your tool list then. Until then do not " +
      "send it again unless the user asks for it, and never offer to flag or report anything: there is no such process.",
  ].join("\n");
}

/** What an app chat's model is told about a disconnect. */
export function appDisconnectResult(
  host: Pick<ToolHost, "ok" | "err">,
  outcome: DisconnectOutcome
): ToolResult {
  switch (outcome.code) {
    case "required":
      return host.err(
        'A service is required, e.g. "googlecalendar" or "whatsapp".'
      );
    case "ambiguous":
      return host.ok(
        `"${outcome.asked}" matches more than one connector: ${outcome.options
          .map((item) => `${item.name} (${item.id})`)
          .join(", ")}. Ask again with one of those.`
      );
    case "unknown":
      return host.err(
        `There is no connector called "${outcome.asked}". Ask connect_connector with no arguments for the list.`
      );
    case "no_messaging":
      return host.err("Messaging is not available in this session.");
    case "platform_off":
    case "disconnected":
      return outcome.code === "disconnected" && outcome.kind !== "messaging"
        ? host.ok(
            `${outcome.name} is disconnected. Its tools are gone from your tool list; ` +
              "connect_connector brings it back when the user wants it again."
          )
        : host.ok(
            `${outcome.name} is disconnected. The platform is switched off. ` +
              "connect_connector switches it back on when the user wants it again."
          );
    case "no_connectors":
      return host.err("Connectors are not available in this session.");
    case "not_connected":
      return host.ok(
        `${outcome.name} is not connected: nothing to disconnect.`
      );
    case "failed":
      return host.err(outcome.error);
  }
}
