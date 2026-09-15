import type { ToolDefinition } from "./definition";

/**
 * Chat apps: list, read, send and auto-reply, one tool per platform. The
 * cross-platform originals stay callable for a model holding an older list
 * but are hidden, so one platform's chats never sit beside another's.
 */
export const MESSAGING_TOOLS: ToolDefinition[] = [
  {
    name: "send_chat_message",
    toolsets: ["messaging"],
    hidden: true,
    description: [
      "Send a message to a person or chat on a connected messaging platform.",
      "",
      "On WhatsApp this sends from the USER'S OWN account — the recipient sees it as them.",
      "Telegram and Discord send as the user's bot. Either way you are messaging a",
      "real person on their behalf: ONLY send when the user asked you to in this",
      "conversation, only what they asked, to who they asked — never on your own",
      "initiative — and quote the message back to them if there is any doubt.",
      "",
      '"to" can be a contact NAME ("Mom", "Ravi") — it resolves against the known contacts',
      "and errors if the name is ambiguous or unknown — or a chat id from list_chats, or on",
      'WhatsApp a phone number in international format (e.g. "+14155551234"). It can also be',
      '"me", which the platform resolves to the user\'s own account — so a message to',
      "themselves needs no number from them.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
        },
        to: {
          type: "string",
          description:
            "A contact name, a chat id from list_chats, or a phone number for WhatsApp.",
        },
        message: { type: "string", description: "The text to send." },
        attachment_path: {
          type: "string",
          description:
            "Absolute path of a file to send with the message (the message becomes its caption). Up to 25MB.",
        },
      },
      required: ["platform", "to", "message"],
    },
    run: (host, args) => host.sendChatMessage(args),
  },
  {
    name: "list_chats",
    toolsets: ["messaging"],
    hidden: true,
    description:
      "The cross-platform overview: which messaging platforms are connected, who the user " +
      "is on each, and a capped sample of contacts. For a platform's contacts use its own " +
      "tool — list_whatsapp_chats, list_telegram_chats, list_discord_chats " +
      "— where nothing from another platform can crowd them out. Lists the synced " +
      "address book plus everyone who has messaged in — with the chat id to reach them. " +
      "Pass a query to search by name, or a platform to list that platform's chats on " +
      "their own — output is capped, with a share kept for every platform, and it says " +
      "how many more each platform has. A platform missing from the rows is NOT a platform " +
      "with no chats: scope to it before concluding that. The user's own " +
      'account is listed too, marked (the user — "me"): that is who they mean by "me" or ' +
      '"myself", so never ask them for their own number. It also says when a platform is ' +
      "connected but not reachable right now, which is why a list can come back empty.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description:
            "List only this platform's chats — the way to see a small platform in full.",
        },
      },
    },
    run: (host, args) => host.listChats(args),
  },
  {
    name: "list_whatsapp_chats",
    toolsets: ["messaging"],
    platform: "whatsapp",
    description:
      "List the user's WhatsApp chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means WhatsApp: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On WhatsApp, a contact's or group's name IS its chat id, so the `to:` value is the name; a phone number in international format also works. " +
      "Pass `only_unread` to list just the chats and groups with messages waiting, each with " +
      'its unread count — the answer to "which groups have new messages?".',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
        only_unread: {
          type: "boolean",
          description:
            "Only chats with unread messages, with the count for each, read " +
            "live from WhatsApp. Reading the counts does not mark anything read.",
        },
      },
    },
    run: (host, args) => host.listChats({ ...args, platform: "whatsapp" }),
  },
  {
    name: "list_telegram_chats",
    toolsets: ["messaging"],
    platform: "telegram",
    description:
      "List the user's Telegram chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means Telegram: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On Telegram, the `to:` value is the chat id shown.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
      },
    },
    run: (host, args) => host.listChats({ ...args, platform: "telegram" }),
  },
  {
    name: "list_discord_chats",
    toolsets: ["messaging"],
    platform: "discord",
    description:
      "List the user's Discord chats and contacts — this platform only, with the `to:` " +
      "value to reach each. Use this rather than list_chats when the user means Discord: " +
      "one platform's address book can never crowd another's out here. Pass a query to " +
      "search by name. On Discord, the `to:` value is the DM or `guild/channel` id shown; names are usernames, not display names.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Name to search for, e.g. "mom". A name that matches a contact ' +
            "exactly lists only that contact — that is who a send goes to. " +
            "Omit to list.",
        },
      },
    },
    run: (host, args) => host.listChats({ ...args, platform: "discord" }),
  },
  {
    name: "send_whatsapp_message",
    toolsets: ["messaging"],
    platform: "whatsapp",
    description: [
      "Send a message to a person or chat on WhatsApp.",
      "",
      'Sends from the USER\'S OWN WhatsApp account — the recipient sees it as them. `to` is a contact or group NAME as WhatsApp shows it (the name IS the chat id), a phone number in international format ("+14155551234"), or "me" for the user\'s own chat.',
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on WhatsApp — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
    run: (host, args) =>
      host.sendChatMessage({ ...args, platform: "whatsapp" }),
  },
  {
    name: "read_whatsapp_messages",
    toolsets: ["messaging"],
    platform: "whatsapp",
    description: [
      "Read recent WhatsApp messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` searches WhatsApp's own full history — archived chats and unsaved numbers included.",
      "",
      "`only_unread` reads what is waiting: every chat with unread messages, and",
      'the newest messages in each, up to its unread count. Use it for "what did',
      'I miss?" and "any new messages?". Reading does not mark anything read.',
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_whatsapp_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        only_unread: {
          type: "boolean",
          description:
            "The unread messages across chats, grouped by chat, read live " +
            "from WhatsApp. Ignores chat_id and query.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
    run: (host, args) =>
      host.readChatMessages({ ...args, platform: "whatsapp" }),
  },
  {
    name: "whatsapp_auto_reply",
    toolsets: ["messaging"],
    botsOnly: true,
    platform: "whatsapp",
    description: [
      "Make this bot answer WhatsApp messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out from the user's own WhatsApp account.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against WhatsApp's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on WhatsApp.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) =>
      host.autoReply({ ...args, platform: "whatsapp" }, callerSession),
  },
  {
    name: "send_telegram_message",
    toolsets: ["messaging"],
    platform: "telegram",
    description: [
      "Send a message to a person or chat on Telegram.",
      "",
      "Sends as the user's Telegram bot. `to` is a contact name or a chat id from list_telegram_chats, or \"me\" for the user's own chat with the bot.",
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on Telegram — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
    run: (host, args) =>
      host.sendChatMessage({ ...args, platform: "telegram" }),
  },
  {
    name: "read_telegram_messages",
    toolsets: ["messaging"],
    platform: "telegram",
    description: [
      "Read recent Telegram messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` searches through Telegram's own search.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_telegram_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
    run: (host, args) =>
      host.readChatMessages({ ...args, platform: "telegram" }),
  },
  {
    name: "telegram_auto_reply",
    toolsets: ["messaging"],
    botsOnly: true,
    platform: "telegram",
    description: [
      "Make this bot answer Telegram messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out as the user's Telegram bot.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against Telegram's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on Telegram.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) =>
      host.autoReply({ ...args, platform: "telegram" }, callerSession),
  },
  {
    name: "send_discord_message",
    toolsets: ["messaging"],
    platform: "discord",
    description: [
      "Send a message to a person or chat on Discord.",
      "",
      "Sends as the user's Discord account. `to` is a DM id or a `guild/channel` id from list_discord_chats, or a username; display names are not ids. \"me\" reaches the user too: it is delivered through the Abacus AI bot's DM when that is linked.",
      "",
      "You are messaging a real person on the user's behalf: ONLY send when the user",
      "asked you to in this conversation, only what they asked, to who they asked —",
      "never on your own initiative — and quote the message back to them if there is",
      "any doubt. A name that is ambiguous or unknown errors rather than guessing.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Who to send to, on Discord — see the description.",
        },
        message: { type: "string", description: "The text to send." },
      },
      required: ["to", "message"],
    },
    run: (host, args) => host.sendChatMessage({ ...args, platform: "discord" }),
  },
  {
    name: "read_discord_messages",
    toolsets: ["messaging"],
    platform: "discord",
    description: [
      "Read recent Discord messages — what came in and what was sent — newest",
      "last. Read-only, and only when the user asks you to check their messages;",
      "do not poll it on your own.",
      "",
      "Two ways in. `chat_id` reads ONE chat by its name or id. `query` finds",
      "messages CONTAINING words — a topic, a place, a thing, something someone",
      'said ("taco bell", "the invoice") — across chats, through the platform\'s',
      "own search; use it whenever the user names something that is not a",
      "contact. Without `query`, this covers messages received while the app has",
      "been running, not the full history. `query` runs per server: pass chat_id (a server or chat) to scope it; without one the joined servers are searched in order, capped at a few. Reads open the channel and can take a while; a read that would queue behind others is refused at once with the stored copy as the fallback.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        chat_id: {
          type: "string",
          description:
            "Only this chat (a `to:` value from list_discord_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text; follow up with chat_id to read the whole thread.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
    run: (host, args) =>
      host.readChatMessages({ ...args, platform: "discord" }),
  },
  {
    name: "discord_auto_reply",
    toolsets: ["messaging"],
    botsOnly: true,
    platform: "discord",
    description: [
      "Make this bot answer Discord messages from chosen people automatically.",
      "Only works in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender), "remove_sender" (sender), "off" (stop answering),',
      '"status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user. Replies go out as the user's Discord account.",
      "This chat stays the user's own. Anyone not allowed is only logged — never",
      "answered. Senders resolve by name against Discord's contacts and people who",
      "have messaged before; if a name does not resolve, ask the user for the exact",
      "contact name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on Discord.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) =>
      host.autoReply({ ...args, platform: "discord" }, callerSession),
  },
  {
    name: "read_chat_messages",
    toolsets: ["messaging"],
    hidden: true,
    description: [
      "Read recent messages from the user's connected messaging platforms — what came in",
      "and what was sent — newest last. Read-only, and only when the user asks you to",
      "check their messages; do not poll it on your own.",
      "",
      "Covers messages received while the app has been running, not the platform's full",
      "history — except `query`, which searches by content through the platform's own",
      "search (WhatsApp: full history, archived chats and unsaved numbers included).",
      "Use `query` when the user asks about a sender or topic that no chat is named",
      "after — a bank, a delivery, 'the message about X'. Incoming messages never start",
      "agent turns by themselves; this tool is how they get read.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description: "Only this platform. Omit for all.",
        },
        chat_id: {
          type: "string",
          description: "Only this chat (an id from list_chats). Omit for all.",
        },
        query: {
          type: "string",
          description:
            "Find messages CONTAINING this text. Returns the matching chats " +
            "with the matching snippet; follow up with chat_id to read the " +
            "whole thread. On Discord, search runs per server: pass chat_id " +
            "(a server or chat) to scope it; without one the joined servers " +
            "are searched in order, capped at a few.",
        },
        limit: {
          type: "number",
          description: "Most recent N messages. Default 50.",
        },
      },
    },
    run: (host, args) => host.readChatMessages(args),
  },
  {
    name: "auto_reply",
    toolsets: ["messaging"],
    botsOnly: true,
    hidden: true,
    description: [
      "Make this bot answer chat messages from chosen people automatically. Only works",
      "in a bot's own chat.",
      "",
      'Actions: "on" (start answering; optional sender to allow in the same call),',
      '"allow_sender" (sender, and platform when more than one is connected),',
      '"remove_sender" (sender, platform likewise), "off" (stop answering), "status".',
      "",
      "Once on, each allowed sender gets a separate conversation where you answer",
      "them; everything written there is delivered to them, as the user (on WhatsApp",
      "from the user's own account, elsewhere as their linked bot). This chat stays",
      "the user's own. Works on every connected platform. Anyone not allowed is only",
      "logged — never answered.",
      "",
      "Senders resolve by name against the platform's contacts and people who have",
      "messaged before. If a name does not resolve, ask the user for the exact contact",
      "name, or have that person send one message and allow them from the log.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["on", "off", "allow_sender", "remove_sender", "status"],
        },
        sender: {
          type: "string",
          description: "The person, by contact name (or id) on the platform.",
        },
        platform: {
          type: "string",
          enum: ["whatsapp", "telegram", "discord"],
          description:
            "Which platform the sender is on. Optional when only one is connected.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.autoReply(args, callerSession),
  },
];
