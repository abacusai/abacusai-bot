import type { ChannelCapabilities } from "@abacus-ai/agent/channel";
import { DOCUMENT_EXTENSIONS } from "@abacus-ai/agent/send-media";

import type { ToolDefinition } from "./definition";

/**
 * Handing finished work over: serving a folder, presenting files. An app chat
 * opens them in a pane; a chat that takes media (the phone) gets them sent
 * into it, and a served page as a screenshot, since a phone cannot open it.
 */

const toChat = (channel: ChannelCapabilities): boolean =>
  channel.media || channel.documents;

/** What `present_deliverable` does with a URL on this computer before it presents one. */
const LOCAL_URL_CHECK = [
  "A URL on this computer is checked first: it must answer, and its page is loaded in a",
  "browser and must not throw. One that fails is not presented, and the result says what",
  "went wrong: fix it and present it again. Never tell the user an app is done or fixed",
  "until it has been presented this way. A page `serve` handed out keeps its URL, and is",
  "served again when it is opened after a restart.",
].join("\n");

/**
 * Share works on a file's row of the files card, so a page served here needs
 * its file listed too. What to tell someone asking how others can see it is
 * the system prompt's (plan-asks.ts).
 */
const SHARE_ROW = [
  "For a page served on this computer, list its html file here as well as its URL, so the",
  "file's row has Share, the public link to send.",
].join("\n");

/** What `present_deliverable` does with a file before it presents one. */
const FILE_CHECK = [
  "A file is opened first: an office file (xlsx, docx, pptx, pdf, csv, jsonl) that does not",
  "open is not presented, and anything the user would hit (broken formulas, links to another",
  "workbook, unfilled blanks) is listed. A translated strings file is compared with its",
  "source: give translatedFrom. Fix what it lists before you call the work done.",
].join("\n");
/**
 * A page that keeps what people enter: the app backs its localStorage with a
 * store on the user's disk, shared by the preview and the installed app
 * (artifact-apps/store.ts), and it starts empty.
 */
const KEEPS_DATA = [
  "A page that keeps what people enter (a tracker, ledger, list, planner, a game's",
  "progress) saves it with localStorage: read on load, write on every change, keep the",
  "same keys across edits. The app keeps it on the user's computer, the same in the",
  "preview and in the installed app. It starts with no rows: no sample, example or demo",
  "entries, not even ones dated today; the empty state says how to add the first. Only a",
  "form's date may start as today.",
].join("\n");

/**
 * The agent says what a page is when it presents it; for a tool or game,
 * present_deliverable's result asks for the one-line install offer (a tool
 * result is followed far more reliably than a hint). Sites keep Share.
 */
const OFFER_APP =
  "Present a page with its kind (tool, game or site); for a tool or game the result says how to offer keeping it as an app.";

const offersApp = (channel: ChannelCapabilities): boolean =>
  channel.pane && !toChat(channel);

export const DELIVERABLES_TOOLS: ToolDefinition[] = [
  {
    name: "install_app",
    toolsets: "always",
    description: [
      "Keep a page you made in this chat on the user's computer as an app: its own window",
      "and launcher, opening without the bot and offline, with its data kept. The same as",
      "Install as app on the page's row.",
      "",
      "Call it only after the user said yes, in this chat, to keeping it as an app; never on",
      "your own, and never for a site or pitch page. Give the page's html path or the URL",
      "serve gave it. The result says it is installed, or why not in plain words: tell the",
      "user that in their language.",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "The page's html path, or its served URL.",
        },
      },
      required: ["target"],
    },
    offeredTo: offersApp,
    run: (host, args, callerSession) => host.installApp(args, callerSession),
  },
  {
    name: "artifact",
    toolsets: "always",
    description: (channel) =>
      [
        "Build a page people can use: a report, dashboard, one-pager, diagram or small working",
        "tool. It opens beside the chat and the user can share it by link. A short answer stays",
        "in the chat. Read the artifact-design skill first.",
        "",
        "Actions:",
        '  "create":  a new page (title, body). `body` is what goes inside <body>; the page\'s',
        "             head, palette and rules are added for you.",
        '  "edit":    small changes (slug, edits). Each `old` must appear exactly once.',
        '  "restore": go back to a saved version (slug, version).',
        "",
        "Every action saves a new version and returns the page's path. Hand that path to",
        "present_deliverable to show it.",
        "",
        KEEPS_DATA,
        ...(offersApp(channel) ? ["", OFFER_APP] : []),
      ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "edit", "restore"] },
        title: { type: "string", description: "create: a short real name." },
        body: {
          type: "string",
          description: "create: the markup inside <body>.",
        },
        slug: {
          type: "string",
          description: "edit, restore: the page's slug, as create returned it.",
        },
        edits: {
          type: "array",
          description: "edit: exact replacements, in order.",
          items: {
            type: "object",
            properties: {
              old: { type: "string" },
              new: { type: "string" },
            },
            required: ["old", "new"],
          },
        },
        version: { type: "number", description: "restore: the version." },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.artifact(args, callerSession),
  },
  {
    name: "serve",
    toolsets: "always",
    description: (channel) =>
      [
        "Serve a directory over http and get back a URL, so a web page you wrote can actually",
        "be opened. Static files only: html, css, js, images.",
        "",
        "Use it the moment you have written a page the user is meant to look at. `bash` cannot",
        "do this: it runs a command to completion, so a dev server started there is killed as",
        "soon as it reports being ready, and the URL answers nothing.",
        "",
        ...(toChat(channel)
          ? [
              "The URL opens on this computer only: the user cannot open it from their phone, and",
              "there is no live link to give them. Hand it to present_deliverable, which sends them",
              "a screenshot of the page. A long write-up reads better as a `page` link.",
            ]
          : [
              "Then hand the URL to present_deliverable: that is what opens the preview pane. A URL",
              "in prose is not previewed and not recorded. The URL opens on this computer only. A",
              "page meant to be seen by others is best one html file, its styles and scripts inside.",
            ]),
        "",
        KEEPS_DATA,
        ...(offersApp(channel) ? ["", OFFER_APP] : []),
        "",
        "Actions:",
        '  "start": serve a directory (directory). Serving it again returns the same URL.',
        '  "stop":  stop serving one (directory).',
        '  "list":  what is being served right now.',
      ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "list"],
          description: "What to do.",
        },
        directory: {
          type: "string",
          description:
            "The directory to serve. A relative path resolves against the workspace directory.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.serve(args, callerSession),
  },
  {
    name: "present_deliverable",
    toolsets: "always",
    description: (channel) =>
      toChat(channel)
        ? [
            "Send the finished work into this chat. Call this at the end of a turn that produced",
            "files, listing what the user asked for, most important first.",
            "",
            "Each item arrives in the chat with your answer: an image (png, jpg, webp) as a picture,",
            `any other file as a document under its file name (${DOCUMENT_EXTENSIONS.join(", ")}; at`,
            "most 16 MB; a code file at most 1 MB). Nothing else goes: not archives, apps or videos, and not a zip or renamed",
            "copy of one. The first text of your answer goes with the first item as its caption, so",
            "keep that short. A served page's URL arrives as a screenshot of the page: the user",
            "cannot open a live preview from their phone. Naming a path in prose sends nothing.",
            "",
            "List the deliverables, not the workings: the report, not the six scratch files it",
            "was assembled from.",
            "",
            "Call it again whenever the user asks to see or get something you already made.",
            "Sending the same file twice is cheap and safe.",
            "",
            LOCAL_URL_CHECK,
          ].join("\n")
        : [
            "Hand the finished work over. Call this at the end of a turn that produced files,",
            "listing what the user asked for, most important first.",
            "",
            "The items become a files card in the chat and are filed as artifacts; in a session",
            "the first one also opens in the preview pane. Naming a path in prose does none of",
            "that, and a file written with `bash` is not recorded anywhere unless it is declared",
            "here. To hand a file to a person on a messaging channel, use send_chat_message with",
            "attachment_path as well.",
            "",
            "List the deliverables, not the workings: the report, not the six scratch files it",
            "was assembled from.",
            "",
            "Call it again whenever the user asks to see, show, open, or look at something you",
            "already made. The pane may have been closed or the app restarted since, and this is",
            "the only way to put the file back on screen. Describing it, or rendering its pages,",
            "into the chat, does not show it. Presenting the same file twice is cheap and safe.",
            "",
            LOCAL_URL_CHECK,
            "",
            FILE_CHECK,
            "",
            SHARE_ROW,
          ].join("\n"),
    inputSchema: (channel) => ({
      type: "object",
      properties: {
        items: {
          type: "array",
          description: toChat(channel)
            ? "The deliverables, most important first. The first one carries your answer's first text."
            : "The deliverables, most important first. The first one is opened in the preview pane.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path to the file, or an http(s) URL (a served app). A relative path resolves against " +
                  "the workspace directory. Files must exist and a URL on this computer must work; this " +
                  "reports the ones that do not.",
              },
              translatedFrom: {
                type: "string",
                description:
                  "For a translated file: the file it was translated from. Every string is compared with its " +
                  "source (missing, untranslated, broken placeholders or numbers, lines shifted onto another id).",
              },
              label: {
                type: "string",
                description:
                  'Short human name, e.g. "Q3 deck (PDF)". Defaults to the file name.',
              },
            },
            required: ["path"],
          },
        },
        summary: {
          type: "string",
          description: "One line about what was produced.",
        },
        ...(offersApp(channel)
          ? {
              kind: {
                type: "string",
                enum: ["tool", "game", "site"],
                description:
                  'For a web page: "tool" keeps the user\'s own data (tracker, ledger, planner, a quiz keeping scores), "game", or "site", a page for others to see (shop, portfolio, pitch, landing).',
              },
            }
          : {}),
      },
      required: ["items"],
    }),
    run: (host, args, callerSession) =>
      host.presentDeliverable(args, callerSession),
  },
];
